// Шрифты для текста на объектах. Файлы лежат в app/web/fonts.

const fontUrl = (file) => new URL(`../../fonts/${file}`, import.meta.url);

// Фирменный JetBrains Mono из брендбука.
export const BRAND_FONT = 'JetBrains Mono';
let brandReady = null;
export function loadBrandFonts() {
  brandReady ??= Promise.all([
    ['JetBrainsMono-Regular.woff2', '400'],
    ['JetBrainsMono-SemiBold.woff2', '600'],
  ].map(async ([file, weight]) => {
    const face = new FontFace(BRAND_FONT, `url(${fontUrl(file)})`, { weight });
    document.fonts.add(await face.load());
  }));
  return brandReady;
}

// Рукописный Caveat (Google Fonts) — мел на доске. Вариативный по насыщенности;
// латиница и кириллица — отдельные файлы с диапазонами, как их отдаёт Google Fonts.
export const HAND_FONT = 'Caveat';
let handReady = null;
export function loadHandwriting() {
  handReady ??= Promise.all([
    ['Caveat-Latin.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
    ['Caveat-Cyrillic.woff2', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  ].map(async ([file, unicodeRange]) => {
    const face = new FontFace(HAND_FONT, `url(${fontUrl(file)})`, { weight: '500 600', unicodeRange });
    document.fonts.add(await face.load());
  }));
  return handReady;
}
