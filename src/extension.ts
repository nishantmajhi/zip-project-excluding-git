import * as vscode from 'vscode';
import * as path from 'path';
import { createZip, ZipCancelled } from './zipper';

async function pickTargetFolder(uri: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
  // Invoked from Explorer context menu with a folder already selected.
  if (uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
      return uri;
    }
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('No folder is open. Open a project folder first.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].uri;
  }

  const pick = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select the folder to zip'
  });
  return pick?.uri;
}

async function zipProject(uri: vscode.Uri | undefined): Promise<void> {
  const targetUri = await pickTargetFolder(uri);
  if (!targetUri) {
    return;
  }

  const targetDir = targetUri.fsPath;
  const defaultName = `${path.basename(targetDir)}.zip`;
  const defaultUri = vscode.Uri.file(path.join(path.dirname(targetDir), defaultName));

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { Zip: ['zip'] },
    saveLabel: 'Create Zip'
  });
  if (!saveUri) {
    return;
  }
  const outputZipPath = saveUri.fsPath;

  const created = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Zipping ${path.basename(targetDir)}`,
      cancellable: true
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      progress.report({ message: 'Adding files…' });

      try {
        const stats = await createZip(targetDir, outputZipPath, {
          signal: controller.signal,
          onProgress: (message) => progress.report({ message })
        });
        for (const link of stats.skippedSymlinks) {
          console.warn('zip: skipped symbolic link', link);
        }
        for (const problem of stats.unreadable) {
          console.warn('zip: could not read', problem);
        }
        return true;
      } catch (err) {
        if (err instanceof ZipCancelled) {
          return false;
        }
        throw err;
      }
    }
  );

  if (!created) {
    return;
  }

  const openFolder = 'Reveal in Explorer';
  const choice = await vscode.window.showInformationMessage(
    `Created ${path.basename(outputZipPath)}`,
    openFolder
  );
  if (choice === openFolder) {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputZipPath));
  }
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'zipProjectExcludingGit.zip',
    (uri: vscode.Uri | undefined) =>
      zipProject(uri).catch((err: any) => {
        vscode.window.showErrorMessage(`Failed to create zip: ${err?.message ?? err}`);
      })
  );
  context.subscriptions.push(disposable);
}

export function deactivate() {}
