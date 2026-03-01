"use strict";

const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const io = require('@actions/io');
const fs = require("fs");
const path = require("path");
const os = require("os");


async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  if (os.platform() === "win32") {
    // Windows: use PowerShell to start background process
    const psCmd = `Start-Process -NoNewWindow -FilePath "${cfd}" -ArgumentList @('tunnel','--url','${protocol}://localhost:${port}','--output','json') -RedirectStandardOutput "${log}" -RedirectStandardError "${log}"`;
    await exec.exec("powershell", ["-Command", psCmd]);
  } else {
    // Unix: use shell to start background process
    await exec.exec("sh", [], { input: `${cfd} tunnel --url ${protocol}://localhost:${port} --output json >${log} 2>&1 &` });
  }


  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    
    // Read and parse log file (supports both JSON lines and plain text)
    let server = "";
    try {
      if (fs.existsSync(log)) {
        const logContent = fs.readFileSync(log, 'utf8');
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
  if (fs.existsSync(log)) {
    try {
      const logContent = fs.readFileSync(log, 'utf8').trim().split('\n');
      const tailLines = logContent.slice(-20).join('\n');
      core.info("Last log lines:\n" + tailLines);
    } catch (e) {
      core.info("Could not read log tail: " + e.message);
    }
  }

  core.warning("Cloudflared failed to get tunnel URL after 60 seconds.");
  return false;
}



async function setOutput(name, value) {
  if (os.platform() === "win32") {
    await exec.exec("powershell", ["-Command", `Add-Content -Path "$env:GITHUB_OUTPUT" -Value "${name}=${value}"`]);
  } else {
    await exec.exec("sh", [], { input: `echo "${name}=${value}" >> $GITHUB_OUTPUT` });
  }
}


async function runLocalhostRun(protocol, port) {
  core.info("Falling back to localhost.run tunnel service...");

  let workingDir = __dirname;
  let log = path.join(workingDir, "./localhost_run.log");

  // localhost.run uses SSH to create HTTP tunnels
  // ssh -o StrictHostKeyChecking=no -R 80:localhost:PORT ssh.localhost.run
  if (os.platform() === "win32") {
    const psCmd = `Start-Process -NoNewWindow -FilePath "ssh" -ArgumentList @('-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=60','-R','80:localhost:${port}','ssh.localhost.run') -RedirectStandardOutput "${log}" -RedirectStandardError "${log}"`;
    await exec.exec("powershell", ["-Command", psCmd]);
  } else {
    await exec.exec("sh", [], { input: `ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R 80:localhost:${port} ssh.localhost.run >${log} 2>&1 &` });
  }

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      if (fs.existsSync(log)) {
        const logContent = fs.readFileSync(log, 'utf8');
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
  if (fs.existsSync(log)) {
    try {
      const logContent = fs.readFileSync(log, 'utf8').trim().split('\n');
      const tailLines = logContent.slice(-20).join('\n');
      core.info("localhost.run last log lines:\n" + tailLines);
    } catch (e) {
      core.info("Could not read localhost.run log tail: " + e.message);
    }
  }

  core.warning("localhost.run failed to get tunnel URL after 60 seconds.");
  return false;
}


async function runPinggy(protocol, port) {
  core.info("Falling back to Pinggy tunnel service...");

  let workingDir = __dirname;
  let log = path.join(workingDir, "./pinggy.log");

  // Pinggy uses SSH: ssh -p 443 -R0:localhost:PORT -o StrictHostKeyChecking=no a.pinggy.io
  if (os.platform() === "win32") {
    const psCmd = `Start-Process -NoNewWindow -FilePath "ssh" -ArgumentList @('-p','443','-R0:localhost:${port}','-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=60','a.pinggy.io') -RedirectStandardOutput "${log}" -RedirectStandardError "${log}"`;
    await exec.exec("powershell", ["-Command", psCmd]);
  } else {
    await exec.exec("sh", [], { input: `ssh -p 443 -R0:localhost:${port} -o StrictHostKeyChecking=no -o ServerAliveInterval=60 a.pinggy.io >${log} 2>&1 &` });
  }

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      if (fs.existsSync(log)) {
        const logContent = fs.readFileSync(log, 'utf8');
        const lines = logContent.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          // Pinggy outputs tunnel URLs like https://xxxx-xx-xx-xx-xx.a.free.pinggy.link
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
  if (fs.existsSync(log)) {
    try {
      const logContent = fs.readFileSync(log, 'utf8').trim().split('\n');
      const tailLines = logContent.slice(-20).join('\n');
      core.info("Pinggy last log lines:\n" + tailLines);
    } catch (e) {
      core.info("Could not read Pinggy log tail: " + e.message);
    }
  }

  core.warning("Pinggy failed to get tunnel URL after 60 seconds.");
  return false;
}


async function runServeo(protocol, port) {
  core.info("Falling back to Serveo tunnel service...");

  let workingDir = __dirname;
  let log = path.join(workingDir, "./serveo.log");

  // Serveo uses SSH: ssh -o StrictHostKeyChecking=no -R 80:localhost:PORT serveo.net
  if (os.platform() === "win32") {
    const psCmd = `Start-Process -NoNewWindow -FilePath "ssh" -ArgumentList @('-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=60','-R','80:localhost:${port}','serveo.net') -RedirectStandardOutput "${log}" -RedirectStandardError "${log}"`;
    await exec.exec("powershell", ["-Command", psCmd]);
  } else {
    await exec.exec("sh", [], { input: `ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -R 80:localhost:${port} serveo.net >${log} 2>&1 &` });
  }

  for (let i = 0; i < 12; i++) {
    await sleep(5000);

    let server = "";
    try {
      if (fs.existsSync(log)) {
        const logContent = fs.readFileSync(log, 'utf8');
        const lines = logContent.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          // Serveo outputs tunnel URLs like https://abcdef1234.serveo.net
          // Require 5+ char subdomain to avoid matching non-tunnel URLs
          const match = line.match(/https?:\/\/([A-Za-z0-9._-]{5,}\.serveo\.net)/);
          if (match && match[1]) {
            server = match[1];
            break;
          }
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
  if (fs.existsSync(log)) {
    try {
      const logContent = fs.readFileSync(log, 'utf8').trim().split('\n');
      const tailLines = logContent.slice(-20).join('\n');
      core.info("Serveo last log lines:\n" + tailLines);
    } catch (e) {
      core.info("Could not read Serveo log tail: " + e.message);
    }
  }

  core.setFailed("Failed to get tunnel URL from Serveo.");
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
  ];

  let chain;
  if (provider) {
    const selected = providers.find(p => p.name === provider);
    if (!selected) {
      core.setFailed(`Unknown provider: "${provider}". Valid values: cf, localhost.run, pinggy, serveo`);
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

