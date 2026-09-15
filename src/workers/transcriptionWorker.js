import { pipeline, env } from '@huggingface/transformers';

console.log('TRANSCRIPTION_WORKER: SCRIPT START');

// Configure environment for v3
env.allowLocalModels = false;
env.useBrowserCache = true;

// Send immediate heartbeat
self.postMessage({ status: 'alive' });

// Global error handling for the worker
self.onerror = (e) => {
    console.error('TRANSCRIPTION_WORKER: Global Error:', e);
    self.postMessage({ status: 'error', error: 'Worker Global Error: ' + (e.message || e) });
};

self.onunhandledrejection = (e) => {
    console.error('TranscriptionWorker: Unhandled Rejection:', e.reason);
    self.postMessage({ status: 'error', error: 'Worker Promise Error: ' + e.reason });
};

// The model is made up of several files (tokenizer, config, encoder, decoder
// weights...), each reporting its own 0-100% progress independently. Forwarding
// those raw events as-is makes the UI's progress bar jump backwards every time
// a new file starts downloading. This aggregates loaded/total bytes across all
// files seen so far into one monotonically-increasing overall percentage.
const fileProgress = new Map();
function reportProgress(x) {
    if (x && x.status === 'progress' && typeof x.loaded === 'number' && typeof x.total === 'number' && x.total > 0) {
        fileProgress.set(x.file, { loaded: x.loaded, total: x.total });
        let loaded = 0, total = 0;
        for (const entry of fileProgress.values()) {
            loaded += entry.loaded;
            total += entry.total;
        }
        self.postMessage({ status: 'progress', progress: total > 0 ? (loaded / total) * 100 : (x.progress || 0) });
    } else {
        self.postMessage(x);
    }
}

// Errors that mean "this network request failed" rather than "this device/
// backend can't run the model". Retrying those with a different `device`
// wastes a full duplicate download and still ends up failing the same way.
function isNetworkError(err) {
    const msg = String(err?.message || err || '');
    return /fetch|network|ERR_|timeout|abort/i.test(msg);
}

class TranscriptionPipeline {
    static task = 'automatic-speech-recognition';
    static model = 'onnx-community/ipa-whisper-base-ONNX';
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            console.log('TranscriptionPipeline: Initializing v3 pipeline:', this.model);
            try {
                try {
                    this.instance = await pipeline(this.task, this.model, {
                        progress_callback,
                        device: 'webgpu',
                    });
                } catch (err) {
                    if (isNetworkError(err)) {
                        // Retrying with WASM won't fix a connectivity problem —
                        // it would just fail again after a second full download
                        // attempt. Let the caller report this as-is.
                        throw err;
                    }
                    console.warn('TranscriptionPipeline: WebGPU unavailable, falling back to WASM:', err.message);
                    this.instance = await pipeline(this.task, this.model, {
                        progress_callback,
                        device: 'wasm'
                    });
                }
                console.log('TranscriptionPipeline: Pipeline ready.');
            } catch (err) {
                console.error('TranscriptionPipeline: Critical Load Error:', err);
                throw err;
            }
        }
        return this.instance;
    }
}

console.log('TranscriptionWorker: Module Script Loaded.');

self.onmessage = async (event) => {
    const { audio, cmd } = event.data;

    try {
        if (cmd === 'load') {
            console.log('TranscriptionWorker: Command: load');
            await TranscriptionPipeline.getInstance(reportProgress);
            self.postMessage({ status: 'ready' });
            return;
        }

        if (audio) {
            console.log('TranscriptionWorker: Command: transcribe');
            const transcriber = await TranscriptionPipeline.getInstance(reportProgress);

            // Handle segments (array of Float32Array) or single buffer
            const audioSegments = Array.isArray(audio) ? audio : [audio];
            let fullTranscript = '';

            for (let i = 0; i < audioSegments.length; i++) {
                const segment = audioSegments[i];
                self.postMessage({
                    status: 'segment_start',
                    index: i,
                    total: audioSegments.length
                });

                const output = await transcriber(segment, {
                    chunk_length_s: 30,
                    stride_length_s: 5,
                    // No `language` here on purpose: this is a multilingual Whisper
                    // fine-tune (neurlang/ipa-whisper-base, trained on 70+ languages),
                    // and its own model card explicitly unforces the decoder's
                    // language token (`forced_decoder_ids = None`) so Whisper
                    // auto-detects the spoken language per segment instead of being
                    // pinned to English — forcing `language: 'en'` here would bias
                    // decoding towards English phonology for every other language,
                    // defeating the point of a "universal" phonetic transcriber.
                    task: 'transcribe',
                    return_timestamps: false,
                    max_new_tokens: 448,
                    num_beams: 5, // Improved decoding strategy
                    repetition_penalty: 1.1,
                    no_repeat_ngram_size: 4,
                    do_sample: false,
                });

                const segmentText = output.text.trim();
                fullTranscript += (fullTranscript ? ' ' : '') + segmentText;

                // Transfer the underlying buffer back instead of letting
                // postMessage clone it — this segment isn't read again here.
                self.postMessage({
                    status: 'segment_complete',
                    index: i,
                    text: segmentText,
                    fullTranscript: fullTranscript,
                    audioSegment: segment // Send back the buffer
                }, [segment.buffer]);
            }

            self.postMessage({
                status: 'complete',
                output: fullTranscript,
            });
        }
    } catch (err) {
        console.error('TranscriptionWorker: Runtime Error:', err);
        self.postMessage({ status: 'error', error: err.message });
    }
};
