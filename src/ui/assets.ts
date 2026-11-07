/** URL of an image extracted by tools/extract-assets.mjs (file names are sanitised there). */
export const assetUrl = (vassalImage: string) => `assets/images/${vassalImage.replace(/[^A-Za-z0-9._-]/g, '_')}`;
