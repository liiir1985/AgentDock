export function greet(name: string): string {
	const trimmed = name.trim();
	return trimmed.length > 0 ? `hello, ${trimmed}` : 'hello, stranger';
}
export const GREETING_VERSION = 1;
