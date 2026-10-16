// Unlock audio on the user's click so a long-running request can chime later.
// Audio is optional: browser restrictions must never interrupt resume work.
export function createReadyChime() {
  let context;

  return {
    prepare() {
      try {
        const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContext) return;
        if (!context || context.state === 'closed') context = new AudioContext();
        if (context.state === 'suspended') void context.resume().catch(() => {});
      } catch { /* Audio may be unavailable or blocked by the browser. */ }
    },

    play() {
      try {
        // Never queue a late notification for the user's next interaction.
        if (context?.state !== 'running') return;
        const start = context.currentTime + 0.01;
        [523.25, 659.25].forEach((frequency, index) => {
          const note = context.createOscillator();
          const volume = context.createGain();
          const at = start + index * 0.16;
          note.type = 'sine';
          note.frequency.setValueAtTime(frequency, at);
          volume.gain.setValueAtTime(0, at);
          volume.gain.linearRampToValueAtTime(0.035, at + 0.025);
          volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
          note.connect(volume);
          volume.connect(context.destination);
          note.onended = () => { note.disconnect(); volume.disconnect(); };
          note.start(at);
          note.stop(at + 0.4);
        });
      } catch { /* A ready draft should still succeed if playback fails. */ }
    },

    dispose() {
      const previous = context;
      context = null;
      try {
        if (previous && previous.state !== 'closed') void previous.close().catch(() => {});
      } catch { /* Cleanup must also tolerate unavailable audio. */ }
    },
  };
}
