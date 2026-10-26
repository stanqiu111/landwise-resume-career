import { useEffect, useState } from 'react';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const STEP_MS = 45;

function prefersStill() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

// A departures-board line: each letter flips through the alphabet, then settles.
// Assistive technology reads the plain text; the tiles are decoration.
// Remount with a new `key` to replay the flip for new text.
export default function FlapText({ text, as: Tag = 'span', className = '' }) {
  const [still] = useState(prefersStill);
  const [tick, setTick] = useState(0);
  const letters = text.toUpperCase().split('');
  const settled = 4 + letters.length * 2;

  useEffect(() => {
    if (still) return undefined;
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      setTick(frame);
      if (frame >= settled) clearInterval(timer);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [still, settled]);

  let index = 0;
  const words = text.toUpperCase().split(' ').map(word => word.split('').map(letter => {
    const position = index++;
    const flipping = !still && tick < 4 + position * 2 && /[A-Z0-9]/.test(letter);
    return { letter: flipping ? CHARS[(tick * 7 + position * 13) % CHARS.length] : letter, flipping };
  }));

  return <Tag className={`flap-text ${className}`.trim()}>
    <span className="flap-sr">{text}</span>
    <span className="flap-words" aria-hidden="true">
      {words.map((tiles, wordIndex) => <span className="flap-word" key={wordIndex}>
        {tiles.map((tile, tileIndex) => <span className={`flap-tile${tile.flipping ? ' is-flipping' : ''}`} key={tileIndex}><span>{tile.letter}</span></span>)}
      </span>)}
    </span>
  </Tag>;
}
