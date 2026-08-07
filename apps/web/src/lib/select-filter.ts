export function selectOptionSearchText(label: unknown): string {
  if (typeof label === 'string') return label
  if (typeof label === 'number') return String(label)
  return ''
}

export function selectFilterOption(input: string, option?: { label?: unknown }) {
  return selectOptionSearchText(option?.label).toLowerCase().includes(input.toLowerCase())
}
