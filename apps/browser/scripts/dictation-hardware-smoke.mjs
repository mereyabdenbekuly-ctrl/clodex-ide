import { app, BrowserWindow, session } from 'electron';
import { createServer } from 'node:http';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDictationSmokeReport,
  DICTATION_SMOKE_MIME_TYPES,
  fixedSmokeFailureReason,
  parseDictationSmokeCli,
} from '../src/shared/dictation-hardware-smoke.js';

const TEST_TIMEOUT_MS = 20_000;

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function writeReportAtomically(outputPath, report) {
  const targetPath = path.resolve(outputPath);
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600).catch(() => undefined);
    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        (error?.code !== 'EEXIST' && error?.code !== 'EPERM')
      ) {
        throw error;
      }
      await rm(targetPath, { force: true });
      await rename(temporaryPath, targetPath);
    }
    await chmod(targetPath, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function emitReport(report, outputPath, output = console.log) {
  if (outputPath) await writeReportAtomically(outputPath, report);
  output(JSON.stringify(report, null, 2));
}

function createRendererSmokeSource(mode) {
  return `
    (async () => {
      const mode = ${JSON.stringify(mode)};
      const mimeTypes = ${JSON.stringify(DICTATION_SMOKE_MIME_TYPES)};
      const isMimeTypeSupported = (mimeType) => {
        try {
          return Boolean(globalThis.MediaRecorder?.isTypeSupported?.(mimeType));
        } catch {
          return false;
        }
      };
      const result = {
        rendererPlatform: navigator.platform,
        support: {
          microphoneCapture: Boolean(navigator.mediaDevices?.getUserMedia),
          mediaRecorder: Boolean(globalThis.MediaRecorder),
          webAudio: Boolean(globalThis.AudioContext || globalThis.webkitAudioContext),
          webRtc: Boolean(globalThis.RTCPeerConnection),
        },
        recorderMimeTypes: Object.fromEntries(
          mimeTypes.map((mimeType) => [mimeType, isMimeTypeSupported(mimeType)]),
        ),
        microphone: null,
        localWebRtc: null,
      };

      if (mode === 'capabilities') {
        result.microphone = { outcome: 'skipped' };
      } else {
        let stream;
        let audioContext;
        let source;
        let analyser;
        try {
          if (!navigator.mediaDevices?.getUserMedia) {
            throw Object.assign(new Error('API unavailable'), {
              name: 'ApiUnavailableError',
            });
          }
          const AudioContextClass =
            globalThis.AudioContext || globalThis.webkitAudioContext;
          if (!AudioContextClass) {
            throw Object.assign(new Error('API unavailable'), {
              name: 'ApiUnavailableError',
            });
          }
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
            },
            video: false,
          });
          const startedAt = performance.now();
          audioContext = new AudioContextClass();
          if (audioContext.state === 'suspended') await audioContext.resume();
          source = audioContext.createMediaStreamSource(stream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 2048;
          source.connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          let peakRms = 0;
          const deadline = performance.now() + 3000;
          while (performance.now() < deadline) {
            analyser.getFloatTimeDomainData(samples);
            let sumSquares = 0;
            for (let index = 0; index < samples.length; index += 1) {
              const sample = samples[index] || 0;
              sumSquares += sample * sample;
            }
            peakRms = Math.max(
              peakRms,
              Math.sqrt(sumSquares / samples.length),
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const decibels = peakRms > 0 ? 20 * Math.log10(peakRms) : -60;
          const peakLevel = Math.round(
            Math.max(0, Math.min(1, (decibels + 60) / 60)) * 100,
          );
          result.microphone = {
            outcome: peakRms >= 0.003 ? 'passed' : 'no-signal',
            durationMs: Math.round(performance.now() - startedAt),
            peakLevel,
            trackCount: stream.getAudioTracks().length,
          };
        } catch (error) {
          result.microphone = {
            outcome: 'failed',
            failureName: error?.name || 'Error',
          };
        } finally {
          source?.disconnect();
          analyser?.disconnect();
          for (const track of stream?.getTracks() || []) track.stop();
          if (audioContext && audioContext.state !== 'closed') {
            await audioContext.close().catch(() => undefined);
          }
        }
      }

      let caller;
      let receiver;
      let channel;
      try {
        if (!globalThis.RTCPeerConnection) {
          throw Object.assign(new Error('API unavailable'), {
            name: 'ApiUnavailableError',
          });
        }
        const startedAt = performance.now();
        caller = new RTCPeerConnection();
        receiver = new RTCPeerConnection();
        caller.onicecandidate = (event) => {
          if (event.candidate) {
            void receiver
              .addIceCandidate(event.candidate)
              .catch(() => undefined);
          }
        };
        receiver.onicecandidate = (event) => {
          if (event.candidate) {
            void caller.addIceCandidate(event.candidate).catch(() => undefined);
          }
        };
        channel = caller.createDataChannel('dictation-smoke');
        const opened = new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
              ),
            5000,
          );
          channel.addEventListener(
            'open',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
        const offer = await caller.createOffer();
        await caller.setLocalDescription(offer);
        await receiver.setRemoteDescription(offer);
        const answer = await receiver.createAnswer();
        await receiver.setLocalDescription(answer);
        await caller.setRemoteDescription(answer);
        await opened;
        result.localWebRtc = {
          outcome: 'connected',
          latencyMs: Math.round(performance.now() - startedAt),
        };
      } catch (error) {
        result.localWebRtc = {
          outcome: 'failed',
          failureName: error?.name || 'Error',
        };
      } finally {
        channel?.close();
        caller?.close();
        receiver?.close();
      }

      return result;
    })()
  `;
}

async function run(options) {
  let window;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
    });
    response.end('<meta charset="utf-8"><title>Dictation smoke</title>');
  });

  try {
    await app.whenReady();
    if (options.mode === 'hardware') {
      session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission) => permission === 'media',
      );
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) => {
          callback(permission === 'media');
        },
      );
    }

    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
      },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to start local smoke server');
    }
    await window.loadURL(`http://127.0.0.1:${address.port}`);

    const smokePromise = window.webContents.executeJavaScript(
      createRendererSmokeSource(options.mode),
    );
    let timeout;
    const rawResult = await Promise.race([
      smokePromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Dictation smoke timed out');
          error.name = 'TimeoutError';
          reject(error);
        }, TEST_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));

    const report = createDictationSmokeReport({
      mode: options.mode,
      hostPlatform: process.platform,
      hostArch: process.arch,
      expectedPlatform: options.expectedPlatform,
      rendererPlatform: rawResult.rendererPlatform,
      support: rawResult.support,
      recorderMimeTypes: rawResult.recorderMimeTypes,
      microphone: {
        outcome: rawResult.microphone?.outcome,
        durationMs: rawResult.microphone?.durationMs,
        peakLevel: rawResult.microphone?.peakLevel,
        trackCount: rawResult.microphone?.trackCount,
        failureReason:
          rawResult.microphone?.outcome === 'failed'
            ? fixedSmokeFailureReason({
                name: rawResult.microphone.failureName,
              })
            : null,
      },
      localWebRtc: {
        outcome: rawResult.localWebRtc?.outcome,
        latencyMs: rawResult.localWebRtc?.latencyMs,
        failureReason:
          rawResult.localWebRtc?.outcome === 'failed'
            ? fixedSmokeFailureReason({
                name: rawResult.localWebRtc.failureName,
              })
            : null,
      },
    });
    await emitReport(report, options.outputPath);
    return report.verdict.passed ? 0 : 2;
  } finally {
    window?.destroy();
    await closeServer(server);
  }
}

let options;
try {
  options = parseDictationSmokeCli(process.argv.slice(2));
} catch (error) {
  const report = createDictationSmokeReport({
    mode: 'hardware',
    hostPlatform: process.platform,
    hostArch: process.arch,
    support: {},
    recorderMimeTypes: {},
    fatalFailureReason: fixedSmokeFailureReason(error),
  });
  console.error(JSON.stringify(report, null, 2));
  app.exit(2);
}

if (options) {
  run(options)
    .then((exitCode) => app.exit(exitCode))
    .catch(async (error) => {
      const report = createDictationSmokeReport({
        mode: options.mode,
        hostPlatform: process.platform,
        hostArch: process.arch,
        expectedPlatform: options.expectedPlatform,
        support: {},
        recorderMimeTypes: {},
        fatalFailureReason: fixedSmokeFailureReason(error),
      });
      await emitReport(report, options.outputPath, console.error).catch(() => {
        console.error(JSON.stringify(report, null, 2));
      });
      app.exit(2);
    });
}
