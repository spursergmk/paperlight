/** Parses common text lines used by a printed PDF contents page. */
export function parsePrintedTocLine(value: string): { title: string; printedPage: string } | null {
  const line = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  const leader = /^(.*?)\s*(?:\.{2,}|…{1,}|·{2,})\s*([0-9]{1,4}|[ivxlcdm]{1,8})$/i.exec(line)
  const spaced = leader || /^(.{3,}?)\s{2,}([0-9]{1,4})$/i.exec(value.trim())
  if (!spaced) return null
  const title = spaced[1].replace(/[.·…\s]+$/, '').trim()
  if (title.length < 2 || /^(?:contents|table of contents|目录)$/i.test(title)) return null
  return { title, printedPage: spaced[2] }
}
