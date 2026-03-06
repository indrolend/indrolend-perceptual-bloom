/**
 * Mid/Side encode and decode helpers.
 *
 * These are the fundamental building blocks for stereo-width processing.
 * In a future JUCE port, these become simple inline functions operating on
 * float* buffers.
 *
 * Mid  = (L + R) / 2  — the mono-compatible centre image
 * Side = (L - R) / 2  — the stereo difference / width information
 */

/** Encode a stereo pair into Mid and Side. */
export function encode(L: number, R: number): { mid: number; side: number } {
  return {
    mid: (L + R) * 0.5,
    side: (L - R) * 0.5,
  };
}

/** Decode Mid and Side back to a stereo pair. */
export function decode(mid: number, side: number): { L: number; R: number } {
  return {
    L: mid + side,
    R: mid - side,
  };
}
