// Visible text separators shared by the renderer (src/render) and ATS extraction (src/preflight/ats.js),
// so the X-ray text and the PDF text use the same characters. They are always real text nodes, never CSS gap.

export const HEADER_SEPARATORS = [' · ', ' | ', ' • '] // accepted in header lines (parser splits on these)
export const DEFAULT_CONTACT_SEP = ' · '                 // used when the source had no separator
export const TAG_SEP = ' · '                             // between chips in the tags variant
export const ORG_SEP = ', '                              // "Title, Org" in every variant
export const DATE_SEP = ' — '                            // "Title, Org — Date" in the compact variant
export const FIELD_SEP = ' | '                           // between head fields in ATS logical text
