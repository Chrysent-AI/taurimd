# Original browser media fixtures

These fixtures were created for this project by Chrysent and are supplied under the project's MIT license. No third-party recordings, images or source documents were copied.

- `figure.svg`: authored geometric teal rectangle and white circle; external image context only.
- `tone.wav`: generated three-second 440 Hz sine, mono 8 kHz PCM signed 16-bit, using FFmpeg's `sine` source with metadata removed.
- `clip.webm`: generated three-second teal 160×90 frame sequence, 10 fps VP8, using FFmpeg's `color` source with metadata removed, no audio.

Committed fixture bytes avoid an FFmpeg dependency when running tests. Browser routes are explicit HTTP/IPC/URL-conversion doubles, not evidence for native Tauri transport, CSP, byte ranges, OS handlers or system-webview codec support. Tests record real engine decode/seek results and distinguish an unsupported video encoding from successful playback.
