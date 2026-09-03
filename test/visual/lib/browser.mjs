// Resolve + ASSERT the pinned headless-shell (build 1217). A silent browser bump changes SwiftShader -> false golden
// diffs, so we never glob "any cached build" — we require this exact one, and derive platform/arch from the host.
import { existsSync } from 'node:fs';

export const PINNED_BUILD = '1217';                 // ms-playwright chromium_headless_shell revision the goldens pin to
// deterministic SOFTWARE WebGL2: SwiftShader kills GPU/driver variance; force sRGB so colour management can't drift.
export const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--force-color-profile=srgb'];

// Which ms-playwright platform dir holds the headless-shell for a given arch on this OS.
function platArchDir(platform, arch){
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'linux')  return arch === 'arm64' ? 'linux-arm64' : 'linux';
  throw new Error(`visual goldens: unsupported platform ${platform} (recording arch is darwin/arm64)`);
}

// exeFor: resolve the cached binary for THIS host arch (default) or an explicit arch (the rare cross-arch check).
export function exeFor({ arch = process.arch, platform = process.platform } = {}){
  const pa = platArchDir(platform, arch);
  const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-${PINNED_BUILD}/chrome-headless-shell-${pa}/chrome-headless-shell`;
  if (!existsSync(exe)) throw new Error(
    `visual goldens: pinned browser (chromium_headless_shell-${PINNED_BUILD}, ${pa}) not found at\n  ${exe}\n` +
    `Install it: npx -y playwright-core@<version-pinning-build-${PINNED_BUILD}> install chromium-headless-shell` +
    ` (or point CH_EXE at a matching binary).`);
  return { exe, build: PINNED_BUILD, platArch: pa };
}

// The recording arch is what the committed goldens are byte-exact on. record.mjs refuses to run off it.
export const RECORDING = { platform: 'darwin', arch: 'arm64' };
export function isRecordingArch(){ return process.platform === RECORDING.platform && process.arch === RECORDING.arch; }
