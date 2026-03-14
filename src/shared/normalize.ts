export function dbTitleToDisplayTitle(rawTitle: string): string {
  return rawTitle.replaceAll("_", " ");
}

export function displayTitleToDbTitle(title: string): string {
  return title.trim().replace(/\s+/g, "_");
}

export function normalizeTitleForSearch(input: string): string {
  return input
    .normalize("NFKC")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function normalizePrefixKey(input: string): string {
  return normalizeTitleForSearch(input).slice(0, 2);
}

export function tokenizeSearchTerms(input: string): string[] {
  return normalizeTitleForSearch(input)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}
