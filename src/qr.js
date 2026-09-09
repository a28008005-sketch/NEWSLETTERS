// QR 코드를 SVG 문자열로 만든다.
// 인쇄물에 들어가므로 벡터로 넣어야 확대해도 깨지지 않고,
// 파일 안에 그대로 박히므로 인쇄할 때 인터넷이 필요 없다.
import QRCode from 'qrcode';

export async function qrSvg(text, { size = 132 } = {}) {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 0,
    // 종이는 접히고 구겨진다. 복원력을 한 단계 높여 둔다.
    errorCorrectionLevel: 'Q',
    color: { dark: '#000000', light: '#ffffff' },
  });
  // 고정 크기로 배치할 수 있도록 width/height 를 지정한다.
  return svg
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<svg /, `<svg width="${size}" height="${size}" `)
    .trim();
}
