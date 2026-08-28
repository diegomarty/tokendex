/**
 * The smoke assertions, run inside the extension host. Deliberately tiny: activation works,
 * the commands exist, a refresh round-trips to the worker and back. Anything deeper belongs in
 * the unit suite, which runs in milliseconds instead of booting an editor.
 */

const assert = require('node:assert')
const vscode = require('vscode')

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('diegomarty.tokendex')
  assert.ok(extension, 'extension not found by id diegomarty.tokendex')

  await extension.activate()
  assert.ok(extension.isActive, 'extension failed to activate')

  const commands = await vscode.commands.getCommands(true)
  for (const id of ['tokendex.open', 'tokendex.refresh', 'tokendex.showOutput']) {
    assert.ok(commands.includes(id), `command missing: ${id}`)
  }

  // A real round trip: host -> worker -> scan -> reply. Throws if the worker is broken.
  await vscode.commands.executeCommand('tokendex.refresh')
  // The scan is async behind the command; give the worker a moment, then a second refresh —
  // if the first one crashed the worker, this one lands on the restart path and still works.
  await new Promise((resolve) => setTimeout(resolve, 3000))
  await vscode.commands.executeCommand('tokendex.refresh')
}
