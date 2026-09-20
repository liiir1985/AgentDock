/**
 * The approval bridge (D37/D44).
 *
 * The property that matters is not "a dialog appears" but "a dialog always settles": a request that is
 * never answered leaves the harness waiting, which D44 records as Copilot's failure mode. So the tests
 * are about the request reaching the wire, the answer coming back to the right waiter, and a cancelled
 * turn settling everything that is still open.
 */

import { describe, expect, test } from 'bun:test';

import { UiBroker, createForwardingUIContext, type UiRequest } from './ui';

function broker(): UiBroker & { sent: UiRequest[]; logs: string[] } {
	const sent: UiRequest[] = [];
	const logs: string[] = [];
	const made = new UiBroker(
		(request) => sent.push(request),
		(message, level) => logs.push(`${level}: ${message}`),
	);
	return Object.assign(made, { sent, logs });
}

describe('UiBroker', () => {
	test('a request goes out as a dialog with an id, and the answer settles it', async () => {
		const ui = broker();
		const answer = ui.request('select', 'Approve?', 'write src/a.ts', ['Approve', 'Deny']);
		expect(ui.sent.length).toBe(1);
		expect(ui.sent[0]).toEqual({
			requestId: 'ui-1',
			kind: 'select',
			title: 'Approve?',
			message: 'write src/a.ts',
			options: ['Approve', 'Deny'],
		});
		ui.resolve('ui-1', 'Approve');
		expect(await answer).toBe('Approve');
	});

	test('a stale or unknown answer is ignored instead of settling the wrong dialog', async () => {
		const ui = broker();
		const first = ui.request('confirm', 'One');
		const second = ui.request('confirm', 'Two');
		ui.resolve('ui-1', 'nope');
		ui.resolve('ui-99', true);
		expect(await first).toBe('nope');
		ui.resolve('ui-2', false);
		expect(await second).toBe(false);
	});

	test('cancelling settles every open dialog as "nobody answered"', async () => {
		const ui = broker();
		const first = ui.request('input', 'One');
		const second = ui.request('confirm', 'Two');
		ui.cancelAll();
		expect(await first).toBeNull();
		expect(await second).toBeNull();
		// A second cancel has nothing left to settle, and a late answer is a no-op.
		ui.cancelAll();
		ui.resolve('ui-1', 'late');
	});

	test('notify is fire-and-forget: no id, no waiter', () => {
		const ui = broker();
		const context = createForwardingUIContext(ui);
		context.notify('tool finished', 'info');
		expect(ui.sent).toEqual([]);
		expect(ui.logs).toEqual(['info: tool finished']);
	});
});

describe('the forwarding UI context', () => {
	test('select answers with the chosen label, and a dismissal is undefined', async () => {
		const ui = broker();
		const context = createForwardingUIContext(ui);
		const picked = context.select('Pick', [{ label: 'A' }, { label: 'B' }]);
		ui.resolve(ui.sent[0].requestId, 'B');
		expect(await picked).toBe('B');

		const dismissed = context.select('Pick', [{ label: 'A' }]);
		ui.resolve(ui.sent[1].requestId, null);
		expect(await dismissed).toBeUndefined();
	});

	test('confirm only treats a true answer as yes', async () => {
		const ui = broker();
		const context = createForwardingUIContext(ui);
		const yes = context.confirm('Approve?', 'write src/a.ts');
		ui.resolve(ui.sent[0].requestId, true);
		expect(await yes).toBe(true);

		const dismissed = context.confirm('Approve?', 'write src/a.ts');
		ui.resolve(ui.sent[1].requestId, null);
		expect(await dismissed).toBe(false);
	});

	test('input keeps text and turns a dismissal into undefined', async () => {
		const ui = broker();
		const context = createForwardingUIContext(ui);
		const typed = context.input('Reason', 'why');
		ui.resolve(ui.sent[0].requestId, 'because');
		expect(await typed).toBe('because');

		const dismissed = context.input('Reason', 'why');
		ui.resolve(ui.sent[1].requestId, null);
		expect(await dismissed).toBeUndefined();
	});

	test('a dialog the window can not serve fails loudly', () => {
		const context = createForwardingUIContext(broker());
		// The full interactive surface is intentionally absent: calling one is a programming error, and
		// pretending the user answered would be worse than throwing.
		expect(() => (context as unknown as { setStatus(key: string, text: string): void }).setStatus('a', 'b')).toThrow();
	});
});
