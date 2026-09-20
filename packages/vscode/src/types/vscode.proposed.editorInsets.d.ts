/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// https://github.com/microsoft/vscode/issues/85682

// Vendored from microsoft/vscode at tag 1.138.0 (D23: the MIT header and this provenance note stay):
// https://raw.githubusercontent.com/microsoft/vscode/1.138.0/src/vscode-dts/vscode.proposed.editorInsets.d.ts
//
// Proposed APIs are not part of `@types/vscode`; the extension must declare
// `"enabledApiProposals": ["editorInsets"]` in package.json and must be launched with
// `--enable-proposed-api agentdock.agentdock`.

declare module 'vscode' {

	export interface WebviewEditorInset {
		readonly editor: TextEditor;
		readonly line: number;
		readonly height: number;
		readonly webview: Webview;
		readonly onDidDispose: Event<void>;
		dispose(): void;
	}

	export namespace window {
		export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
	}
}
