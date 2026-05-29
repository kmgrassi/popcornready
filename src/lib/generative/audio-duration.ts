// Measures the real playback duration of an audio buffer without shelling out
// to ffprobe or pulling in a media library. ElevenLabs returns MP3 by default
// (mp3_44100_128), with WAV as the main alternative, so we parse those two
// container formats directly. Anything we cannot decode returns null, and the
// caller falls back to the requested/estimated duration.

const MPEG_BITRATES: Record<string, (number | null)[]> = {
  // index 0 = "free", index 15 = "bad"; both treated as unusable.
  "1-1": [null, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, null],
  "1-2": [null, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, null],
  "1-3": [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null],
  "2-1": [null, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, null],
  // MPEG-2/2.5 Layer II and Layer III share the same bitrate table.
  "2-2": [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, null],
  "2-3": [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, null],
};

const MPEG_SAMPLE_RATES: Record<number, (number | null)[]> = {
  3: [44100, 48000, 32000, null], // MPEG1
  2: [22050, 24000, 16000, null], // MPEG2
  0: [11025, 12000, 8000, null], // MPEG2.5
};

function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString("ascii", 0, 3) !== "ID3") return 0;
  const flags = buf[5];
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const footer = flags & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

// Sum each MPEG audio frame's duration. Handles CBR and VBR because we read the
// bitrate/sample-rate out of every frame header rather than assuming uniformity.
function mp3DurationSec(buf: Buffer): number | null {
  let pos = id3v2Size(buf);
  let total = 0;
  let frames = 0;

  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
      // Not a frame sync. If we have not found any frame yet, scan forward;
      // otherwise the stream has ended (trailing tags/garbage).
      if (frames === 0) {
        pos++;
        continue;
      }
      break;
    }

    const versionBits = (buf[pos + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buf[pos + 1] >> 1) & 0x03; // 3=LayerI, 2=LayerII, 1=LayerIII
    const bitrateIndex = (buf[pos + 2] >> 4) & 0x0f;
    const sampleRateIndex = (buf[pos + 2] >> 2) & 0x03;
    const padding = (buf[pos + 2] >> 1) & 0x01;

    if (versionBits === 1 || layerBits === 0) {
      if (frames === 0) {
        pos++;
        continue;
      }
      break;
    }

    const layer = 4 - layerBits; // 1, 2, or 3
    const mpegGroup = versionBits === 3 ? 1 : 2;
    const bitrates = MPEG_BITRATES[`${mpegGroup}-${layer}`];
    const sampleRates = MPEG_SAMPLE_RATES[versionBits];
    const bitrateKbps = bitrates?.[bitrateIndex] ?? null;
    const sampleRate = sampleRates?.[sampleRateIndex] ?? null;

    if (!bitrateKbps || !sampleRate) {
      if (frames === 0) {
        pos++;
        continue;
      }
      break;
    }

    const samplesPerFrame =
      layer === 1 ? 384 : layer === 3 && versionBits !== 3 ? 576 : 1152;
    const bitrate = bitrateKbps * 1000;

    let frameLength: number;
    if (layer === 1) {
      frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
    } else {
      frameLength = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    }
    if (frameLength <= 0) break;

    total += samplesPerFrame / sampleRate;
    frames++;
    pos += frameLength;
  }

  return frames > 0 ? total : null;
}

function wavDurationSec(buf: Buffer): number | null {
  if (
    buf.length < 12 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let pos = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (pos + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", pos, pos + 4);
    const chunkSize = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (chunkId === "fmt " && body + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(body + 8);
    } else if (chunkId === "data") {
      dataSize = Math.min(chunkSize, buf.length - body);
    }
    pos = body + chunkSize + (chunkSize & 1); // chunks are word-aligned
  }

  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

// Returns the measured duration in seconds, or null if the format is not one we
// can decode (e.g. raw PCM with no header, or opus).
export function measureAudioDurationSec(
  bytes: Buffer,
  extension?: string
): number | null {
  if (!bytes || bytes.length === 0) return null;

  const ext = (extension || "").toLowerCase();
  // Trust the bytes over the extension: sniff the magic header first.
  const looksWav =
    bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF";
  if (looksWav) return wavDurationSec(bytes);
  if (ext === "wav") return wavDurationSec(bytes);

  // MP3 is the default; treat unknown extensions as a best-effort MP3 parse
  // only when a frame sync or ID3 tag is actually present.
  if (ext === "mp3" || ext === "" || ext === "mpeg") {
    return mp3DurationSec(bytes);
  }
  return null;
}
