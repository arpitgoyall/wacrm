const TEMPORARY_NAME = /^inbox_[0-9a-f]{32}$/

export function isTemporaryTemplateName(name: string): boolean {
  return TEMPORARY_NAME.test(name)
}
