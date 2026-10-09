// Package entry declared by the `pi.extensions` manifest. Pi loads this file
// through jiti and expects the extension factory as the default export; the
// indirection keeps `src/` the single implementation root.
export { default } from "../src/extension";
