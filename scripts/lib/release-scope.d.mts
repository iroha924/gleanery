export type ReleaseKind = "none" | "npm" | "plugin";

export function isPackageInput(file: string): boolean;
export function isNpmOnlyInput(file: string): boolean;
export function releaseKind(files: readonly string[]): ReleaseKind;
export function withoutReleaseVersion(text: string | null): string | null;
