import { join } from "node:path";
import type { GitCredentialMetadataRunner } from "./gitCredentialMetadataProcess.js";

// 固定脚本只读取 TargetName/UserName；CredentialBlob 保留为指针，绝不解引用或输出。
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LCodeGitCredentialMetadata {
  [StructLayout(LayoutKind.Sequential)] struct Credential {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr buffer);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static List<Dictionary<string,string>> Read(string[] prefixes, out bool partial) {
    uint count; IntPtr buffer; partial=false;
    var items=new List<Dictionary<string,string>>();
    if(!CredEnumerateW(null,0,out count,out buffer)) {
      if(Marshal.GetLastWin32Error()==1168) return items;
      throw new InvalidOperationException("credential-metadata-unavailable");
    }
    try {
      partial=count>5000;
      for(int i=0;i<Math.Min(count,5000);i++) {
        var item=(Credential)Marshal.PtrToStructure(Marshal.ReadIntPtr(buffer,i*IntPtr.Size),typeof(Credential));
        if(item.Type!=1) continue;
        string target=Marshal.PtrToStringUni(item.TargetName) ?? "";
        string clean=target.StartsWith("LegacyGeneric:target=",StringComparison.OrdinalIgnoreCase)?target.Substring(21):target;
        bool accepted=false;
        foreach(string prefix in prefixes) if(clean.StartsWith(prefix+":",StringComparison.OrdinalIgnoreCase)) accepted=true;
        if(!accepted) continue;
        if(items.Count>=200) {partial=true;break;}
        string username=Marshal.PtrToStringUni(item.UserName) ?? "";
        if(target.Length<=4096 && username.Length<=512)
          items.Add(new Dictionary<string,string>{{"target",target},{"userName",username}});
      }
      return items;
    } finally { CredFree(buffer); }
  }
}
'@
$partial = $false
$items = [LCodeGitCredentialMetadata]::Read([string[]]$inputData.namespaces, [ref]$partial)
[pscustomobject]@{items=@($items.ToArray());partial=$partial} | ConvertTo-Json -Depth 5 -Compress
`;

export async function readWindowsGitCredentialMetadata(
  runner: GitCredentialMetadataRunner,
  namespaces: string[],
  signal: AbortSignal,
) {
  const executable = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return runner({
    executable,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    input: JSON.stringify({ namespaces }),
    signal,
  });
}
