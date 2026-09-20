/**
 * One visual transition per state change (D11).
 *
 * The insets (old side), the new-side decorations and the CodeLens action row are three independent
 * surfaces that VS Code repaints on its own schedule, and only the CodeLens row has a callback: the
 * provider calls `onQuery` at the end of every `provideCodeLenses` query, i.e. right before the row
 * is rebuilt (~400ms after the state change). So the commit is *synchronised to that query*:
 * `refreshSynced()` only marks the state dirty and asks for a fresh lens query, `commitVisual()` —
 * called from `onQuery` — draws the insets and the decorations in the same tick, and the document
 * jumps once instead of twice.
 *
 * Text-driven updates go through `render()` instead, which commits immediately: deferring those
 * would leave the highlight trailing the cursor while the user types.
 */

import * as vscode from 'vscode';
import type { Hunk } from '@agentdock/core';
import type { HunkCodeLensProvider } from './actions';
import type { DecorationRenderer } from './decorations';
import type { InsetsRenderer } from './insets';

/** Safety net: if the row is never queried (the document is not on screen), don't stay stale. */
const VISUAL_FALLBACK_MS = 1000;
/** An editor created before the window finished restoring may not be in `visibleTextEditors` yet,
 *  and no later event would re-render it. */
const RENDER_RETRY_LIMIT = 5;
const RENDER_RETRY_DELAY = 200;

export interface RenderSyncOptions {
	insets: InsetsRenderer;
	decorations: DecorationRenderer;
	codeLenses: HunkCodeLensProvider;
	/** The pending hunks to draw for this editor, or [] when the document is not part of the review surface. */
	hunksFor(editor: vscode.TextEditor): Hunk[];
}

export class RenderSync implements vscode.Disposable {
	private visualDirty = false;
	private visualFallback: NodeJS.Timeout | undefined;
	private retry: NodeJS.Timeout | undefined;
	private renderRetries = 0;

	constructor(private readonly options: RenderSyncOptions) {}

	dispose(): void {
		if (this.visualFallback) {
			clearTimeout(this.visualFallback);
			this.visualFallback = undefined;
		}
		if (this.retry) {
			clearTimeout(this.retry);
			this.retry = undefined;
		}
	}

	/** Mark the visuals dirty and hand the commit to the next CodeLens query. */
	refreshSynced(): void {
		this.visualDirty = true;
		this.options.codeLenses.refresh();
		if (!this.visualFallback) {
			this.visualFallback = setTimeout(() => this.commitVisual(), VISUAL_FALLBACK_MS);
		}
	}

	/** Commit now and rebuild the row — for changes that came from the document itself. */
	render(editor?: vscode.TextEditor): void {
		this.commitVisual(editor);
		this.options.codeLenses.refresh();
	}

	commitVisual(editor?: vscode.TextEditor): void {
		if (this.visualFallback) {
			clearTimeout(this.visualFallback);
			this.visualFallback = undefined;
		}
		if (!this.visualDirty) {
			return;
		}
		this.visualDirty = false;
		const target = this.pickEditor(editor);
		if (!target) {
			if (this.renderRetries < RENDER_RETRY_LIMIT) {
				this.renderRetries++;
				// Stay dirty: the retry below is the only thing left that will draw this state.
				this.visualDirty = true;
				this.retry = setTimeout(() => this.commitVisual(), RENDER_RETRY_DELAY);
			}
			return;
		}
		this.renderRetries = 0;
		const hunks = this.options.hunksFor(target);
		// One hunks array for both layers: the old-side rows and the new-side highlight then always
		// describe the same selection, even if the model changed while we were waiting.
		this.options.insets.render(target, hunks);
		this.options.decorations.render(target, hunks);
	}

	/** The editor to draw on: the asked-for one, else the first visible one that has something to draw. */
	private pickEditor(editor?: vscode.TextEditor): vscode.TextEditor | undefined {
		if (editor && this.options.hunksFor(editor).length > 0) {
			return editor;
		}
		return vscode.window.visibleTextEditors.find((candidate) => this.options.hunksFor(candidate).length > 0);
	}
}
