// Is a NATURAL image a fairer ceiling than a drawn one?
//
// Fetch a photo first, e.g.:
//   curl -sL -o cats.jpg https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg
// then run from packages/server so node resolves /transformers:
//   IMAGE=./cats.jpg node ../../experiments/clip-natural-baseline.mjs
import { RawImage, AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, CLIPTextModelWithProjection }
  from "@huggingface/transformers";

const ID = "Xenova/clip-vit-base-patch32";
const [vm, proc, tm, tok] = await Promise.all([
  CLIPVisionModelWithProjection.from_pretrained(ID),
  AutoProcessor.from_pretrained(ID),
  CLIPTextModelWithProjection.from_pretrained(ID),
  AutoTokenizer.from_pretrained(ID),
]);
const cos = (a,b) => { let d=0,na=0,nb=0; for (let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return d/(Math.sqrt(na)*Math.sqrt(nb)); };
async function embedText(t){ const { text_embeds } = await tm(tok([t],{padding:true,truncation:true})); return Float32Array.from(text_embeds.data); }
async function embedImg(img){ const { image_embeds } = await vm(await proc(img)); return Float32Array.from(image_embeds.data); }

const S = process.env.S;
// The real photograph, and the same photo crushed to 32x32 — the resolution the GA works at.
const full = await RawImage.fromURL(`./cats.jpg`);
const small = await (await RawImage.fromURL(`./cats.jpg`)).resize(32,32);

const prompt = "a photograph of a cat";
const te = await embedText(prompt);
console.log(`prompt: "${prompt}"\n`);
console.log(`natural photo, full res (${full.width}x${full.height}) : ${cos(await embedImg(full), te).toFixed(4)}`);
console.log(`same photo, crushed to 32x32                : ${cos(await embedImg(small), te).toFixed(4)}`);
console.log(`GA-evolved 32x32 noise (measured earlier)   : 0.3189`);
