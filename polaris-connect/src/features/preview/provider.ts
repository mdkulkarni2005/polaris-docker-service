/**
 * Preview provider abstraction.
 * Swap "webcontainer" | "docker" here (or via NEXT_PUBLIC_PREVIEW_PROVIDER) to change provider.
 */
export type PreviewProviderType = "webcontainer" | "docker";

export const PREVIEW_PROVIDER: PreviewProviderType =
  (process.env.NEXT_PUBLIC_PREVIEW_PROVIDER as PreviewProviderType) ?? "webcontainer";

export const isDockerProvider = (): boolean => PREVIEW_PROVIDER === "docker";
