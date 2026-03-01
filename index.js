"use strict";

const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");


function startBackgroundProcess(executable, args, logFile) {
  let child;
  if (os.platform() === 'win32') {
    // On Windows, SSH and other TUI programs write directly to the console buffer,
    // bypassing stdout/stderr file redirection in .bat files.
    // We spawn a detached helper Node script that pipes the child's output to the
    // log file.  Because the helper is detached, it (and the tunnel process) survive
    // after the main Action Node process calls process.exit().
    const helperScript = path.join(__dirname, 'spawn_helper.js');
    child = spawn(process.execPath, [helperScript, logFile, executable, ...args], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
  } else {
    const fd = fs.openSync(logFile, 'w');
    child = spawn(executable, args, {
      stdio: ['ignore', fd, fd],
      detached: true,
    });
  }
  child.on('error', (err) => {
    core.info(`Background process error for ${executable}: ${err.message}`);
  });
  child.unref();
}


async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Strip ANSI escape sequences and terminal control characters from text.
// SSH-based tunnel services (Pinggy, etc.) may output TUI with box-drawing
// and ANSI codes when stdout is redirected on Windows.
function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
             .replace(/\x1B\][^\x07]*\x07/g, '')
             .replace(/\x1B[()][A-Z0-9]/g, '')
             .replace(/\x1B[\x20-\x2F]*[\x40-\x7E]/g, '')
             .replace(/[\x00-\x08\x0E-\x1F]/g, '');
}

// Read log file content with shared access (Windows cmd.exe keeps the file locked).
function readLogFile(logPath) {
  if (!fs.existsSync(logPath)) return '';
  // Use fd with 'r' flag to open in shared read mode
  const fd = fs.openSync(logPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return '';
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return stripAnsi(buf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}


let sshKeyEnsured = false;
async function ensureSshKey() {
  if (sshKeyEnsured) return;
  const sshDir = path.join(os.homedir(), ".ssh");
  const keyFile = path.join(sshDir, "id_rsa");
  if (!fs.existsSync(keyFile)) {
    core.info("Generating SSH key for tunnel services...");
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700, recursive: true });
    }
    await exec.exec("ssh-keygen", ["-t", "rsa", "-b", "4096", "-f", keyFile, "-N", "", "-q"]);
  } else {
    core.info("SSH key already exists.");
  }
  sshKeyEnsured = true;
}


async function download() {
  const CF_MAC_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-darwin-arm64.tgz";
  const CF_MAC_AMD64 = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-darwin-amd64.tgz";
  const CF_Linux = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-linux-amd64";
  const CF_Linux_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-linux-arm64";
  const CF_Win = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-windows-amd64.exe";
  const CF_Win_ARM = "https://github.com/cloudflare/cloudflared/releases/download/2025.11.1/cloudflared-windows-arm64.exe";

  const isARM = os.arch() === "arm64" || os.arch() === "aarch64";
  let link = CF_Win;
  let ext = "";
  
  if (os.platform() === "darwin") {
    link = isARM ? CF_MAC_ARM : CF_MAC_AMD64;
    ext = "tgz";
  } else if (os.platform() === "linux") {
    link = isARM ? CF_Linux_ARM : CF_Linux;
  } else if (os.platform() === "win32") {
    link = isARM ? CF_Win_ARM : CF_Win;
  }


  let workingDir = __dirname;
  core.info("Downloading: " + link);
  const img = await tc.downloadTool(link);
  core.info("Downloaded file: " + img);

  // Basic validation of downloaded artifact
  try {
    const stat = fs.statSync(img);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error("Downloaded file is missing or empty");
    }
  } catch (err) {
    core.setFailed("Download failed: " + err.message);
    throw err;
  }
  
  if (os.platform() === "darwin") {
    const tarFile = path.join(workingDir, "./cf." + ext);
    await io.mv(img, tarFile);
    await exec.exec("tar", ["-xzf", tarFile, "-C", workingDir]);
    try {
      await fs.promises.unlink(tarFile);
    } catch (err) {
      core.info("Could not remove tar file: " + err.message);
    }
  } else if (os.platform() === "linux") {
    await io.mv(img, path.join(workingDir, "./cloudflared"));
    await exec.exec("chmod", ["+x", path.join(workingDir, "./cloudflared")]);
  } else {
    await io.mv(img, path.join(workingDir, "./cloudflared.exe"));
  }
}

async function run(protocol, port) {
  let workingDir = __dirname;

  let cfd = path.join(workingDir, "./cloudflared");
  let log = path.join(workingDir, "./cf.log");
  
  if (os.platform() === "win32") {
    cfd += ".exe";
  }

  // Try to update cloudflared
  try {
    await exec.exec(cfd, ["update"]);
  } catch (e) {
    core.info("Update failed or not needed: " + e.message);
  }

  // Start tunnel in background
  startBackgroundProcess(cfd, ['tunnel', '--url', `${protocol}://localhost:${port}`, '--output', 'json'], log);


  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    
    // Read and parse log file (supports both JSON lines and plain text)
    let server = "";
    try {
      const logContent = readLogFile(log);
      const lines = logContent.split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        // Regex-first parse to handle non-JSON lines
        const regexMatch = line.match(/https?:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/);
        if (regexMatch && regexMatch[1]) {
          server = regexMatch[1];
          break;
        }

        // Fallback to JSON parse if line is JSON
        try {
          const jsonLine = JSON.parse(line);
          if (jsonLine.message && typeof jsonLine.message === "string") {
            const msgMatch = jsonLine.message.match(/https?:\/\/([A-Za-z0-9.-]+\.trycloudflare\.com)/);
            if (msgMatch && msgMatch[1]) {
              server = msgMatch[1];
              break;
            }
          }
        } catch (e) {
          // Skip invalid JSON lines
        }
      }
    } catch (e) {
      core.info("Error reading log: " + e.message);
    }

    if (!server) {
      continue;
    }
    core.info("server: " + server);
    
    // Write to GITHUB_OUTPUT
    await setOutput("server", server);
    return true;
  }
  
  // On timeout, surface a helpful log snippet for debugging
  try {
    const logContent = readLogFile(log).trim().split('\n');
    const tailLines = logContent.slice(-20).join('\n');
    core.info("Last log lines:\n" + tailLines);
  } catch (e) {
    core.info("Could not read log tail: " + e.message);
  }

  core.warning("Cloudflared failed to get tunnel URL after 60 seconds.");
  return false;
}



async function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${value}\n`);
  }
}


async function runLocalhostRun(protocol, port) {
  // localhost.run only supports HTTP tunnels
  if (protocol === "tcp") {
    core.warning("localhost.run does not support TCP tunnels, skipping.");
    return false;
  }

  core.info("Falling back to localhost.run tunnel service...");

  await ensureSshKey();

  let workingDir = __dirname;
  let log = path.join(workingDir, "./localhost_run.log");

  // localhost.run uses SSH to create HTTP tunnels
  // ssh -o StrictHostKeyChecking=no -R 80:localhost:PORT ssh.localhost.run
  startBackgroundProcess('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=60', '-R', `80:localhost:${port}`, 'ssh.localhost.run'], log);

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      const logContent = readLogFile(log);
      const lines = logContent.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        // localhost.run outputs tunnel URLs like https://xxxx.lhr.life
        const match = line.match(/https?:\/\/([A-Za-z0-9._-]+\.lhr\.life)/);
        if (match && match[1]) {
          server = match[1];
          break;
        }
      }
    } catch (e) {
      core.info("Error reading localhost.run log: " + e.message);
    }

    if (!server) {
      continue;
    }
    core.info("localhost.run server: " + server);

    await setOutput("server", server);
    return true;
  }

  // On timeout, surface log for debugging
  try {
    const logContent = readLogFile(log).trim().split('\n');
    const tailLines = logContent.slice(-20).join('\n');
    core.info("localhost.run last log lines:\n" + tailLines);
  } catch (e) {
    core.info("Could not read localhost.run log tail: " + e.message);
  }

  core.warning("localhost.run failed to get tunnel URL after 60 seconds.");
  return false;
}


async function runPinggy(protocol, port) {
  core.info("Falling back to Pinggy tunnel service...");

  await ensureSshKey();

  let workingDir = __dirname;
  let log = path.join(workingDir, "./pinggy.log");

  // Pinggy uses SSH: for HTTP use a.pinggy.io, for TCP use tcp@a.pinggy.io
  const sshUser = protocol === "tcp" ? "tcp@a.pinggy.io" : "a.pinggy.io";
  startBackgroundProcess('ssh', ['-p', '443', `-R0:localhost:${port}`, '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=60', sshUser], log);

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      const logContent = readLogFile(log);
      const lines = logContent.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        if (protocol === "tcp") {
          // TCP mode: match tcp://host:port
          const match = line.match(/tcp:\/\/([A-Za-z0-9._-]+\.pinggy\.link:\d+)/);
          if (match && match[1]) {
            server = match[1];
            break;
          }
        } else {
          // HTTP mode: match https://xxxx.pinggy.link
          const match = line.match(/https?:\/\/([A-Za-z0-9._-]+\.pinggy\.link)/);
          if (match && match[1]) {
            server = match[1];
            break;
          }
        }
      }
    } catch (e) {
      core.info("Error reading Pinggy log: " + e.message);
    }

    if (!server) {
      continue;
    }
    core.info("Pinggy server: " + server);

    await setOutput("server", server);
    return true;
  }

  // On timeout, surface log for debugging
  try {
    const logContent = readLogFile(log).trim().split('\n');
    const tailLines = logContent.slice(-20).join('\n');
    core.info("Pinggy last log lines:\n" + tailLines);
  } catch (e) {
    core.info("Could not read Pinggy log tail: " + e.message);
  }

  core.warning("Pinggy failed to get tunnel URL after 60 seconds.");
  return false;
}


async function runServeo(protocol, port) {
  // Serveo only supports HTTP tunnels
  if (protocol === "tcp") {
    core.warning("Serveo does not support TCP tunnels, skipping.");
    return false;
  }

  core.info("Falling back to Serveo tunnel service...");

  await ensureSshKey();

  let workingDir = __dirname;
  let log = path.join(workingDir, "./serveo.log");

  // Serveo: HTTP uses -R 80:localhost:PORT
  startBackgroundProcess('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=60', '-R', `80:localhost:${port}`, 'serveo.net'], log);

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      const logContent = readLogFile(log);
      const lines = logContent.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        // HTTP mode: match https://xxxx.serveousercontent.com or https://xxxx.serveo.net
        const match = line.match(/https?:\/\/([A-Za-z0-9._-]+\.serveousercontent\.com)/)
          || line.match(/https?:\/\/([A-Za-z0-9._-]{5,}\.serveo\.net)/);
        if (match && match[1]) {
          server = match[1];
          break;
        }
      }
    } catch (e) {
      core.info("Error reading Serveo log: " + e.message);
    }

    if (!server) {
      continue;
    }
    core.info("Serveo server: " + server);

    await setOutput("server", server);
    return true;
  }

  // On timeout, surface log for debugging
  try {
    const logContent = readLogFile(log).trim().split('\n');
    const tailLines = logContent.slice(-20).join('\n');
    core.info("Serveo last log lines:\n" + tailLines);
  } catch (e) {
    core.info("Could not read Serveo log tail: " + e.message);
  }

  core.setFailed("Failed to get tunnel URL from Serveo.");
  return false;
}


async function runLocaltunnel(protocol, port) {
  // localtunnel only supports HTTP tunnels
  if (protocol === "tcp") {
    core.warning("localtunnel does not support TCP tunnels, skipping.");
    return false;
  }

  core.info("Falling back to localtunnel service...");

  let workingDir = __dirname;
  let log = path.join(workingDir, "./localtunnel.log");

  // Install and run localtunnel via npx
  startBackgroundProcess('npx', ['-y', 'localtunnel', '--port', `${port}`], log);

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      const logContent = readLogFile(log);
      const lines = logContent.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        // localtunnel outputs: your url is: https://xxxx.loca.lt
        const match = line.match(/https?:\/\/([A-Za-z0-9._-]+\.loca\.lt)/);
        if (match && match[1]) {
          server = match[1];
          break;
        }
      }
    } catch (e) {
      core.info("Error reading localtunnel log: " + e.message);
    }

    if (!server) {
      continue;
    }
    core.info("localtunnel server: " + server);

    await setOutput("server", server);
    return true;
  }

  // On timeout, surface log for debugging
  try {
    const logContent = readLogFile(log).trim().split('\n');
    const tailLines = logContent.slice(-20).join('\n');
    core.info("localtunnel last log lines:\n" + tailLines);
  } catch (e) {
    core.info("Could not read localtunnel log tail: " + e.message);
  }

  core.warning("localtunnel failed to get tunnel URL after 60 seconds.");
  return false;
}


async function main() {

  let protocol = core.getInput("protocol");
  core.info("protocol: " + protocol);
  if (!protocol) {
    protocol = "tcp";
  }

  let port = core.getInput("port");
  core.info("port: " + port);
  if (!port) {
    core.setFailed("No port !");
    return;
  }

  let provider = (core.getInput("provider") || "").trim().toLowerCase();
  core.info("provider: " + (provider || "(auto)"));

  // Define the provider chain
  const providers = [
    { name: "cf",            fn: async () => { await download(); return await run(protocol, port); } },
    { name: "localhost.run", fn: async () => await runLocalhostRun(protocol, port) },
    { name: "pinggy",        fn: async () => await runPinggy(protocol, port) },
    { name: "serveo",        fn: async () => await runServeo(protocol, port) },
    { name: "localtunnel",   fn: async () => await runLocaltunnel(protocol, port) },
  ];

  let chain;
  if (provider) {
    const selected = providers.find(p => p.name === provider);
    if (!selected) {
      core.setFailed(`Unknown provider: "${provider}". Valid values: cf, localhost.run, pinggy, serveo, localtunnel`);
      return;
    }
    chain = [selected];
  } else {
    chain = providers;
  }

  let success = false;
  for (const p of chain) {
    try {
      core.info(`Trying provider: ${p.name}`);
      success = await p.fn();
    } catch (e) {
      core.warning(`${p.name} failed: ${e.message}`);
      success = false;
    }
    if (success) break;
  }

  if (!success) {
    const tried = chain.map(p => p.name).join(", ");
    core.setFailed(`Failed to get tunnel URL. Tried: ${tried}`);
  }


  process.exit();
}



main().catch(ex => {
  core.setFailed(ex.message);
});

