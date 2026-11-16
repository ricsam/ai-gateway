// Control characters (except tab and line feed), DEL, C1 controls and bidirectional
// overrides. Names and other values come from users and login providers, so they
// must not reach an administrator's terminal as escape sequences.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const escapeCharacter = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Shows control characters as visible \uXXXX escapes, so text cannot drive the terminal. */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, escapeCharacter);
}
