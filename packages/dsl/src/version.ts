/**
 * The wire format version.
 *
 * Bump the MAJOR when a stored tree stops reifying, the MINOR when a node type
 * or prop is added. Corpus rows carry this so an old tree is detectable after a
 * vocabulary change.
 */
export const SCHEMA_VERSION = "1.0.0";
