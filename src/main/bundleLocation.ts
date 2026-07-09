export type BundleLocation =
  | { packaged: true; resourcesPath: string }
  | { packaged: false; appPath: string };
