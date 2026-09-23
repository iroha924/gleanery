export type ReleaseKind = "none" | "plugin";

export function isPackageInput(file: string): boolean;
export function releaseKind(files: readonly string[]): ReleaseKind;
export function withoutReleaseVersion(text: string | null): string | null;
