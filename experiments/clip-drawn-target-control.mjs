// Is the evolved image RECOGNISABLE, or is the GA exploiting CLIP?
// Compare an evolved genome's score against a genuinely-drawn target image.
import { scoreImageAgainstPrompt } from "../packages/server/src/eval/clip-backend.mjs";

const W = 32, H = 32;
// An actual red circle on white — what a human means by the prompt.
function redCircle() {
  const rgb = new Array(W * H * 3);
  const cx = W / 2, cy = H / 2, r = W * 0.35;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    rgb[i] = 255; rgb[i+1] = inside ? 0 : 255; rgb[i+2] = inside ? 0 : 255;
  }
  return { width: W, height: H, rgb };
}
function noise(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const rgb = new Array(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  return { width: W, height: H, rgb };
}

const PROMPT = "a red circle on a white background";
console.log(`prompt: "${PROMPT}"\n`);
console.log(`a genuinely drawn red circle : ${(await scoreImageAgainstPrompt(redCircle(), PROMPT)).toFixed(4)}`);
console.log(`random noise                 : ${(await scoreImageAgainstPrompt(noise(7), PROMPT)).toFixed(4)}`);
console.log(`GA best after 4000 evals     : 0.3449   (measured in the previous run)`);
