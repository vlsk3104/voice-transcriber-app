import dotenv from 'dotenv';
import { App, type SayFn } from '@slack/bolt';
import { OpenAI } from 'openai';
import fs from 'fs';
import { promises as fsp } from 'fs';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import { pipeline } from 'stream/promises';

dotenv.config();

// 環境変数の検証
function validateEnvVariables(): void {
  const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'];
  const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingEnvVars.length > 0) {
    console.error('Please set these variables in your .env file');
    process.exit(1);
  }
}

// Slackアプリとオムニの初期化
function initializeClients(): { app: App; openai: OpenAI } {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
  });

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  return { app, openai };
}

// ファイルをダウンロードする関数
async function downloadFile(fileUrl: string, outputPath: string): Promise<void> {
  const response = await axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`
    }
  });

  await pipeline(response.data, fs.createWriteStream(outputPath));
  console.log('File downloaded and saved:', outputPath);
}

// ファイルを分割する関数
async function splitAudioFile(inputPath: string, outputDir: string, segmentDuration: number = 300): Promise<string[]> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        return reject(new Error(`FFprobe failed: ${err.message}`));
      }

      ffmpeg(inputPath)
        .outputOptions([
          `-f segment`,
          `-segment_time ${segmentDuration}`,
          `-reset_timestamps 1`,
          `-map 0:a`
        ])
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .output(path.join(outputDir, 'segment_%03d.mp3'))
        .on('start', (commandLine: string) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress: { percent: number }) => {
          console.log('Processing: ' + progress.percent + '% done');
        })
        .on('end', async () => {
          try {
            const files = await fsp.readdir(outputDir);
            resolve(files.filter(file => file.startsWith('segment_')).sort());
          } catch (err) {
            reject(new Error(`Failed to read output directory: ${err instanceof Error ? err.message : String(err)}`));
          }
        })
        .on('error', (err: Error, stdout: string, stderr: string) => {
          console.error('FFmpeg stdout:', stdout);
          console.error('FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg failed: ${err.message}`));
        })
        .run();
    });
  });
}

// 音声ファイルの文字起こしを行う関数
async function transcribeAudio(openai: OpenAI, filePath: string): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
  });
  return transcription.text;
}

// ファイル処理関数
async function processAudioFile(file: any, client: any, channelId: string, openai: OpenAI): Promise<void> {
  console.log('Processing audio file:', file.name);

  const tempFilePath = `/tmp/${file.id}.${file.filetype}`;
  let outputDir: string | null = null;

  try {
    await downloadFile(file.url_private, tempFilePath);

    const stats = await fsp.stat(tempFilePath);
    const fileSizeInMegabytes = stats.size / (1024 * 1024);

    let transcriptionText = '';

    if (fileSizeInMegabytes > 25) {
      console.log('File size exceeds 25MB. Splitting the file...');
      outputDir = `/tmp/${file.id}_segments`;
      await fsp.mkdir(outputDir, { recursive: true });

      const segments = await splitAudioFile(tempFilePath, outputDir);
      console.log(`File split into ${segments.length} segments`);

      for (const segment of segments) {
        const segmentPath = path.join(outputDir, segment);
        console.log(`Processing segment: ${segmentPath}`);
        transcriptionText += await transcribeAudio(openai, segmentPath) + ' ';
      }
    } else {
      transcriptionText = await transcribeAudio(openai, tempFilePath);
    }

    console.log('Transcription completed');

    await client.chat.postMessage({
      channel: channelId,
      text: `文字起こし結果: (${file.name}):\n${transcriptionText}`
    });

    console.log('Transcription result posted to Slack');

  } catch (error) {
    console.error('Error processing audio file:', error);
    throw error;
  } finally {
    await cleanupFiles(tempFilePath, outputDir);
  }
}

// ファイルのクリーンアップ関数
async function cleanupFiles(tempFilePath: string, outputDir: string | null): Promise<void> {
  try {
    if (tempFilePath && await fsp.access(tempFilePath).then(() => true).catch(() => false)) {
      await fsp.unlink(tempFilePath);
    }
    if (outputDir && await fsp.access(outputDir).then(() => true).catch(() => false)) {
      await fsp.rm(outputDir, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    console.error('Error during cleanup:', cleanupError);
  }
}

// メインの実行関数
async function main(): Promise<void> {
  validateEnvVariables();
  const { app, openai } = initializeClients();

  app.event('app_mention', async ({ event, client, say }: { event: any; client: any; say: SayFn }) => {
    console.log('App mention event received:', event);

    try {
      if (event.files && event.files.length > 0) {
        const audioFiles = event.files.filter((file: any) => file.mimetype.startsWith('audio/'));

        if (audioFiles.length > 0) {
          await say('音声ファイルを受け取りました。文字起こしを開始します。');

          for (const file of audioFiles) {
            await processAudioFile(file, client, event.channel, openai);
          }
        } else {
          await say('添付されたファイルに音声ファイルが含まれていません。');
        }
      } else {
        await say('こんにちは！音声ファイルを添付してメンションしていただければ、文字起こしを行います。');
      }
    } catch (error) {
      console.error('Error in app_mention event handler:', error);
      await say('申し訳ありません。文字起こし処理中にエラーが発生しました。');
    }
  });

  try {
    await app.start();
    console.log('⚡️ Bolt app is running!');
  } catch (error) {
    console.error('Failed to start app:', error);
  }
}

main();
