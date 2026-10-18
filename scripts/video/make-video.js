/**
 * 把录制好的 raw.webm 转成 B 站可投稿的 mp4，并把字幕烧进画面。
 *
 * 用法：node scripts/video/make-video.js
 * 前置：record.js 已生成 out/raw.webm + out/timeline.json；完整 ffmpeg 在 binaries/ffmpeg/ffmpeg.exe
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'out');
const FFMPEG = 'C:/Users/Administrator/.workbuddy/binaries/ffmpeg/ffmpeg.exe';

const tl = JSON.parse(fs.readFileSync(path.join(OUT, 'timeline.json'), 'utf8'));
const marks = tl.marks || [];
const total = tl.duration || 45;

// ── 生成 ASS 字幕
const HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Microsoft YaHei,54,&H00FFFFFF,&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,1,0,1,4,2,2,120,120,96,1
Style: Title,Microsoft YaHei,110,&H00FFFFFF,&H000000FF,&H00403020,&H96000000,-1,0,0,0,100,100,3,0,1,5,3,5,80,80,0,1
Style: Url,Microsoft YaHei,44,&H00FFFFFF,&H000000FF,&H00201810,&H96000000,-1,0,0,0,100,100,2,0,1,3,2,2,120,120,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const ts = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};

let events = '';
// 片头标题：0.2s 到第一条字幕
const firstT = marks.length ? marks[0].t : 1.2;
events += `Dialogue: 1,${ts(0.2)},${ts(Math.max(1.0, firstT - 0.15))},Title,,0,0,0,,{\\fad(220,180)}TrendSift\n`;

marks.forEach((m, i) => {
  const start = m.t;
  const next = marks[i + 1] ? marks[i + 1].t - 0.28 : total - 0.2;
  if (next <= start) return;
  const isLast = i === marks.length - 1;
  const style = isLast ? 'Url' : 'Sub';
  events += `Dialogue: 0,${ts(start)},${ts(next)},${style},,0,0,0,,{\\fad(180,180)}${m.text}\n`;
});

fs.writeFileSync(path.join(OUT, 'subs.ass'), HEAD + events, 'utf8');
console.log('字幕：' + marks.length + ' 条 → out/subs.ass');

// ── 合成为 mp4
const mp4 = path.join(OUT, 'trendsift-promo.mp4');
if (fs.existsSync(mp4)) fs.unlinkSync(mp4);
console.log('转码中（1080p / h264）…');
execFileSync(
  FFMPEG,
  ['-y', '-i', 'raw.webm', '-vf', 'ass=subs.ass', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
   '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '30', 'trendsift-promo.mp4'],
  { cwd: OUT, stdio: 'inherit' }
);

const kb = Math.round(fs.statSync(mp4).size / 1024);
console.log('完成：' + mp4 + '（' + kb + ' KB，' + total.toFixed(1) + ' 秒）');
