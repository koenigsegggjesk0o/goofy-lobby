/**
 * Probe diagnostik WebRTC antar-dua konteks browser (bukan produk).
 * Menjawab: kandidat ICE apa yang dihasilkan (host IP / mDNS .local /
 * srflx STUN), dan apakah dua konteks bisa tersambung langsung.
 * Jalankan: bun scripts/dev/probe-webrtc.mjs [--no-stun]
 */
import { chromium } from '@playwright/test';

const STUN = process.argv.includes('--no-stun') ? [] : [{ urls: 'stun:stun.l.google.com:19302' }];

const browser = await chromium.launch();
const contextA = await browser.newContext();
const contextB = await browser.newContext();
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
for (const page of [pageA, pageB]) {
  await page.goto('about:blank');
}

async function makePeer(page) {
  await page.evaluate((iceServers) => {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('probe');
    window.__pc = pc;
    window.__cands = [];
    pc.onicecandidate = (event) => {
      if (event.candidate !== null) window.__cands.push(event.candidate.candidate);
    };
  }, STUN);
}

async function gatherCandidates(page, label) {
  // tunggu gathering selesai (maks 8 dtk)
  const done = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const pc = window.__pc;
        if (pc.iceGatheringState === 'complete') return resolve(true);
        const timer = setTimeout(() => resolve(false), 8000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve(true);
          }
        };
      }),
  );
  const cands = await page.evaluate(() => window.__cands);
  console.log(`[${label}] gathering complete: ${done}`);
  for (const c of cands) console.log(`  [${label}] ${c.replace(/\s+/g, ' ')}`);
  return cands;
}

console.log(`iceServers: ${JSON.stringify(STUN)}`);
await makePeer(pageA);
await makePeer(pageB);

// offer dari A
const offer = await pageA.evaluate(async () => {
  const offer = await window.__pc.createOffer();
  await window.__pc.setLocalDescription(offer);
  return window.__pc.localDescription;
});
await pageB.evaluate(async (desc) => {
  await window.__pc.setRemoteDescription(desc);
  const answer = await window.__pc.createAnswer();
  await window.__pc.setLocalDescription(answer);
}, offer);
const answer = await pageB.evaluate(() => window.__pc.localDescription);
await pageA.evaluate(async (desc) => {
  await window.__pc.setRemoteDescription(desc);
}, answer);

// tunggu kandidat terkumpul di kedua sisi
const candsA = await gatherCandidates(pageA, 'A');
const candsB = await gatherCandidates(pageB, 'B');

// tukar kandidat (full trickle)
const toInit = (raw) => {
  const parts = raw.split(' ');
  return { candidate: parts.slice(0, 8).join(' '), sdpMid: '0', sdpMLineIndex: 0 };
};
for (const c of candsA) {
  await pageB.evaluate(async (init) => {
    try {
      await window.__pc.addIceCandidate(init);
    } catch (error) {
      console.log('addIceCandidate B gagal:', String(error));
    }
  }, toInit(c));
}
for (const c of candsB) {
  await pageA.evaluate(async (init) => {
    try {
      await window.__pc.addIceCandidate(init);
    } catch (error) {
      console.log('addIceCandidate A gagal:', String(error));
    }
  }, toInit(c));
}

// poll state maks 20 dtk
for (let i = 0; i < 40; i++) {
  const stateA = await pageA.evaluate(() => window.__pc.connectionState);
  const stateB = await pageB.evaluate(() => window.__pc.connectionState);
  if (i % 5 === 0) console.log(`t+${(i * 0.5).toFixed(1)}s A=${stateA} B=${stateB}`);
  if (stateA === 'connected' && stateB === 'connected') {
    console.log('TERHUBUNG ✅');
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
const finalA = await pageA.evaluate(() => window.__pc.connectionState);
const finalB = await pageB.evaluate(() => window.__pc.connectionState);
console.log(`final: A=${finalA} B=${finalB} ${finalA === 'connected' ? '✅' : '❌'}`);

await contextA.close();
await contextB.close();
await browser.close();
