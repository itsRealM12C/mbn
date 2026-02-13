// Lightweight modular extractor for Huawei / Honor MBN boot logos.
// Robust BMP header discovery + correct handling of 16bpp RGB565 vs BGR565.

const fileInput = document.getElementById('file');
const logEl = document.getElementById('log');
const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');
const img = document.getElementById('preview');
const downloadBtn = document.getElementById('download');

let currentBlob = null;

function log(s='') {
  logEl.textContent += s + '\n';
}

function clearUI() {
  logEl.textContent = '';
  img.style.display = 'none';
  canvas.style.display = 'none';
  downloadBtn.disabled = true;
  currentBlob = null;
}

fileInput.addEventListener('change', async (e) => {
  clearUI();
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  processBuffer(buf, f.size);
});

function readUint32LE(arr, off){ return (arr[off]) | (arr[off+1]<<8) | (arr[off+2]<<16) | (arr[off+3]<<24); }
function readInt32LE(arr, off){ let v=readUint32LE(arr,off); return v|0; }
function readUint16LE(arr, off){ return (arr[off]) | (arr[off+1]<<8); }

function plausibleHeader(arr, off){
  // Verify 'BM' and basic sane fields
  if (off<0 || off+54>arr.length) return false;
  if (arr[off]!==0x42 || arr[off+1]!==0x4D) return false;
  const fileSize = readUint32LE(arr, off+2);
  const pixOff = readUint32LE(arr, off+10);
  const dibSize = readUint32LE(arr, off+14);
  if (dibSize < 12 || dibSize > 4096) return false;
  // Try to read width/height if within bounds
  const w = readInt32LE(arr, off+18);
  const h = readInt32LE(arr, off+22);
  const bpp = readUint16LE(arr, off+28);
  if (!Number.isFinite(w) || Math.abs(w) > 10000) return false;
  if (!Number.isFinite(h) || Math.abs(h) > 10000) return false;
  if (![1,4,8,16,24,32].includes(bpp)) return false;
  if (pixOff <= 54 || pixOff >= arr.length) return false;
  // fileSize in header should be <= actual file length + small tolerance
  if (fileSize && fileSize > arr.length + 16384) return false;
  return true;
}

function findBestBmpOffset(arr){
  // Many boot .bin images store BMPs at aligned offsets (0x400, 0x1000). Check aligned scans first for .bin dumps,
  // then fall back to full bytewise scan. This improves finding BMPs inside raw flash dumps.
  const tryOffsets = (step) => {
    for (let i=0;i<arr.length-1;i+=step){
      if (arr[i]===0x42 && arr[i+1]===0x4D){
        if (plausibleHeader(arr,i)) return i;
      }
    }
    return -1;
  };

  // Prefer 0x400 (1 KiB-ish) alignment, then 0x1000.
  let found = tryOffsets(0x400);
  if (found >= 0) return found;
  found = tryOffsets(0x1000);
  if (found >= 0) return found;

  // Finally try 4-byte aligned scan (fast) and then full bytewise.
  for (let i=0;i<arr.length-1;i+=4){
    if (arr[i]===0x42 && arr[i+1]===0x4D){
      if (plausibleHeader(arr,i)) return i;
    }
  }

  for (let i=0;i<arr.length-1;i++){
    if (arr[i]===0x42 && arr[i+1]===0x4D){
      if (plausibleHeader(arr,i)) return i;
    }
  }

  // fallback: return first BM occurrence (even if header not fully plausible)
  for (let i=0;i<arr.length-1;i++){
    if (arr[i]===0x42 && arr[i+1]===0x4D) return i;
  }
  return -1;
}

function swapChannelsImageData(imgData, mapFn){
  // helper if we need to reorder channels or apply transform
  for (let i=0;i<imgData.data.length;i+=4){
    const [r,g,b,a] = mapFn([imgData.data[i], imgData.data[i+1], imgData.data[i+2], imgData.data[i+3]]);
    imgData.data[i]=r; imgData.data[i+1]=g; imgData.data[i+2]=b; imgData.data[i+3]=a;
  }
}

function decodeRGB565ToImage(arr, pixelStart, w, h, topDown, isBGR){
  const imgData = ctx.createImageData(w,h);
  let src = pixelStart;
  for (let y=0;y<h;y++){
    const row = topDown ? y : (h-1-y);
    for (let x=0;x<w;x++){
      if (src+1 >= arr.length) break;
      const v = arr[src] | (arr[src+1]<<8);
      src += 2;
      let r = (v>>11)&0x1F;
      let g = (v>>5)&0x3F;
      let b = v & 0x1F;
      // expand to 8-bit
      r = (r<<3)|(r>>2);
      g = (g<<2)|(g>>4);
      b = (b<<3)|(b>>2);
      if (isBGR) {
        // swap r<->b
        const tmp=r; r=b; b=tmp;
      }
      const di = (row*w + x)*4;
      imgData.data[di]=r; imgData.data[di+1]=g; imgData.data[di+2]=b; imgData.data[di+3]=255;
    }
  }
  return imgData;
}

function attemptParseAtOffset(arr, bmpOffset){
  const dvOff = bmpOffset;
  const pixOff = readUint32LE(arr, dvOff+10);
  const dibSize = readUint32LE(arr, dvOff+14);
  const w = readInt32LE(arr, dvOff+18);
  const hRaw = readInt32LE(arr, dvOff+22);
  const bpp = readUint16LE(arr, dvOff+28);
  const h = Math.abs(hRaw);
  const topDown = hRaw < 0;
  return { pixOff, dibSize, w, h, hRaw, bpp, topDown, bmpOffset };
}

function renderBmpFromOffset(arr, params){
  const {bmpOffset, pixOff, w, h, bpp, topDown} = params;
  // prepare raw BMP buffer (used for non-16bpp). For 16bpp we will generate a PNG from the canvas after rendering.
  const bmpBuf = arr.slice(bmpOffset);
  const rawBmpBlob = new Blob([bmpBuf], {type: 'image/bmp'});
  // do not set currentBlob here for 16bpp; we'll create a correct-colored blob after rendering

  log(`BMP at ${bmpOffset}, WÃ—H: ${w}Ã—${h}, BPP: ${bpp}, topDown:${topDown}`);
  log(`Exact BMP size: ${bmpBuf.length} bytes`);

  if (bpp === 16) {
    // Determine color ordering heuristically:
    // sample first few pixels and check if blue component > red -> likely BGR (Honor)
    const sampleStart = bmpOffset + pixOff;
    if (sampleStart+2 < arr.length){
      const s = arr[sampleStart] | (arr[sampleStart+1]<<8);
      const sr = ((s>>11)&0x1F);
      const sg = ((s>>5)&0x3F);
      const sb = (s&0x1F);
      const r8 = (sr<<3)|(sr>>2);
      const g8 = (sg<<2)|(sg>>4);
      const b8 = (sb<<3)|(sb>>2);
      const isHonorStyle = (b8 > r8);
      log(isHonorStyle ? 'Detected Honor-style (BGR565) pixel order' : 'Detected Huawei-style (RGB565) pixel order');
      // Render into canvas
      canvas.width = w; canvas.height = h;
      const imgData = decodeRGB565ToImage(arr, bmpOffset + pixOff, w, h, topDown, isHonorStyle);
      ctx.putImageData(imgData, 0, 0);
      canvas.style.display = 'block';
      img.style.display = 'none';
      // Create a downloadable PNG from the corrected canvas so the downloaded image matches the preview colors.
      downloadBtn.disabled = true;
      canvas.toBlob((b) => {
        if (b) {
          currentBlob = b;
          downloadBtn.disabled = false;
          log('Prepared downloadable PNG from canvas (colors match preview).');
        } else {
          // fallback to raw BMP if toBlob failed
          currentBlob = rawBmpBlob;
          downloadBtn.disabled = false;
          log('Canvas toBlob failed, falling back to raw BMP blob for download.');
        }
      }, 'image/png');
    } else {
      log('Not enough data to sample pixels for 16bpp.');
      // fallback: allow raw BMP download
      currentBlob = rawBmpBlob;
      downloadBtn.disabled = false;
    }
  } else {
    // For non-16bpp, show raw BMP via <img> (browser will handle)
    const url = URL.createObjectURL(rawBmpBlob);
    img.src = url;
    img.onload = ()=> URL.revokeObjectURL(url);
    img.style.display = 'block';
    canvas.style.display = 'none';
    currentBlob = rawBmpBlob;
    downloadBtn.disabled = false;
  }
}

function processBuffer(buf, fileSize){
  log(`File size: ${fileSize} bytes`);
  const best = findBestBmpOffset(buf);
  if (best < 0) { log('No BMP signature found'); return; }
  log(`Candidate BMP offset: ${best}`);

  let params = attemptParseAtOffset(buf, best);

  // validate params; if invalid for Honor cases we try to search alternate 'BM' locations
  const sane = (params.w>0 && params.w<=4096 && params.h>0 && params.h<=4096 && params.pixOff > 54 && (params.pixOff + (params.w*params.h*(params.bpp/8)) <= buf.length + 65536));
  if (!sane) {
    log('Header looks suspicious â€” searching other candidates...');
    // scan all BM occurrences and pick the first plausible one
    let found = -1;
    for (let i=0;i<buf.length-1;i++){
      if (buf[i]===0x42 && buf[i+1]===0x4D){
        const p = attemptParseAtOffset(buf,i);
        if (p.w>0 && p.w<=4096 && p.h>0 && p.h<=4096 && p.pixOff > 54 && (p.pixOff <= buf.length)){
          found = i; params = p; break;
        }
      }
    }
    if (found<0) {
      log('No better BMP header found; proceeding with first candidate.');
    } else {
      log(`Found better BMP at ${found}`);
    }
  }

  // Final sanity clamp: if width/height are swapped (common in some broken dumps), try to detect and fix.
  if (params.w>params.h && params.w>2000 && params.h<200) {
    log('Large width / small height suspicious â€” attempting swap...');
    const swapped = { ...params, w: params.h, h: params.w };
    // do a lightweight bounds check using size and bpp
    const expectedBytes = swapped.w * swapped.h * (params.bpp/8);
    if (params.pixOff + expectedBytes <= buf.length + 1024) {
      params = swapped;
      log(`Swapped dims â†’ ${params.w}Ã—${params.h}`);
    } else {
      log('Swap would exceed buffer bounds, skipping swap.');
    }
  }

  renderBmpFromOffset(buf, params);
}

downloadBtn.addEventListener('click', ()=>{
  if (!currentBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(currentBlob);
  a.download = 'bootlogo.bmp';
  a.click();
  URL.revokeObjectURL(a.href);
});
