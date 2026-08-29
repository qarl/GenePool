// Shared RENDER buffer: the per-bot display state the viewer draws each frame. Each worker writes its bots'
// slots after update() (current positions); the main thread reads it and streams frames to the browser. Float32
// is plenty for pixels. Separate from the frozen SoA (which is tick-start + lacks angle) so rendering never
// perturbs the simulation.

export const R_X = 0;
export const R_Y = 1;
export const R_ANGLE = 2;
export const R_ENERGY = 3;
export const R_HUE = 4;      // 0..360, derived from the genome (stable per bot)
export const R_ALIVE = 5;
export const R_STRIDE = 6;

export function makeRenderBuffer(maxBots) {
    return new SharedArrayBuffer(maxBots * R_STRIDE * Float32Array.BYTES_PER_ELEMENT);
}

// Genome -> a stable vivid hue (matches viewer.html's hueOf: genes[3]+2*genes[7]+3*genes[11], mod 256, ->deg).
export function hueOfGenes(genes) {
    const n = genes.length;
    const h = (genes[3 % n] * 1 + genes[7 % n] * 2 + genes[11 % n] * 3) % 256;
    return (h / 256) * 360;
}
