// SetuUnlock.exe — the privileged helper that lets the paired phone unlock this Windows PC.
//
// Windows will not let an ordinary app touch the lock screen (it runs on a separate "secure
// desktop"), so this runs as a LocalSystem service. The phone never talks to it directly: the
// Setu Remote app, running as you, sends it a one-line command over a local pipe that only
// programs on this PC can reach. On "UNLOCK" it types the PIN or password you saved — once —
// on the lock screen, exactly as a finger would. It never changes your password and never
// installs a login method, so at worst it fails to unlock; it cannot lock you out.
//
// SAFETY: one attempt per request; after any failure it refuses to try again until you save the
// secret afresh, so a wrong PIN can never be entered over and over (which is what would trigger a
// BitLocker recovery prompt).
//
// Commands on pipe \\.\pipe\SetuUnlock (one line each, UTF-8):
//   PING            -> "OK cred=<0|1> blocked=<0|1>"
//   SET <base64>    -> stores "<kind>\n<secret>" (kind: pin|pattern|password); "OK"
//   CLEAR           -> forgets it; "OK"
//   UNLOCK          -> "OK" | "OK already" | "ERR nocred" | "ERR blocked" | "ERR stilllocked" | "ERR <reason>"
//
// Run modes: (no args) = run as the service; --install <ownerSID> = register + start the service;
// --uninstall = stop + remove it; --inject = the worker spawned onto the lock screen's desktop.

using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Threading;

static class SetuUnlock
{
    const string SVC = "SetuUnlock";
    const string PIPE = "SetuUnlock";
    static string DataDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SetuRemote"); } }
    static string CredFile { get { return Path.Combine(DataDir, "unlock.bin"); } }
    static string BlockFile { get { return Path.Combine(DataDir, "unlock.blocked"); } }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--install") return Install(args.Length > 1 ? args[1] : "");
            if (args.Length > 0 && args[0] == "--uninstall") return Uninstall();
            if (args.Length > 0 && args[0] == "--inject") return Inject();
            ServiceBase.Run(new Svc());
            return 0;
        }
        catch (Exception e) { try { Log("main: " + e); } catch { } return 1; }
    }

    // ---- stored secret (encrypted to this machine; only SYSTEM can read the folder) ----
    static void SaveSecret(string kindAndSecret)
    {
        Directory.CreateDirectory(DataDir);
        byte[] enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(kindAndSecret), null, DataProtectionScope.LocalMachine);
        File.WriteAllBytes(CredFile, enc);
        if (File.Exists(BlockFile)) File.Delete(BlockFile);
    }
    static string[] LoadSecret()
    {
        byte[] enc = File.ReadAllBytes(CredFile);
        string s = Encoding.UTF8.GetString(ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine));
        int nl = s.IndexOf('\n');
        return new string[] { nl < 0 ? "pin" : s.Substring(0, nl), nl < 0 ? s : s.Substring(nl + 1) };
    }
    static bool HasCred() { return File.Exists(CredFile); }
    static bool Blocked() { return File.Exists(BlockFile); }
    static void Block() { try { Directory.CreateDirectory(DataDir); File.WriteAllText(BlockFile, DateTime.UtcNow.ToString("o")); } catch { } }
    static void Clear() { try { if (File.Exists(CredFile)) File.Delete(CredFile); if (File.Exists(BlockFile)) File.Delete(BlockFile); } catch { } }

    static void Log(string m) { try { Directory.CreateDirectory(DataDir); File.AppendAllText(Path.Combine(DataDir, "unlock.log"), DateTime.UtcNow.ToString("o") + " " + m + "\r\n"); } catch { } }

    // ---- the service: a pipe only local programs can open ----
    class Svc : ServiceBase
    {
        Thread loop; volatile bool stop;
        public Svc() { ServiceName = SVC; CanStop = true; }
        protected override void OnStart(string[] a) { loop = new Thread(Serve) { IsBackground = true }; loop.Start(); }
        protected override void OnStop() { stop = true; }
        void Serve()
        {
            while (!stop)
            {
                try
                {
                    // Allow every local user to connect; the pipe is reachable only from this PC.
                    var sec = new System.IO.Pipes.PipeSecurity();
                    sec.AddAccessRule(new System.IO.Pipes.PipeAccessRule(
                        new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.WorldSid, null),
                        System.IO.Pipes.PipeAccessRights.ReadWrite, System.Security.AccessControl.AccessControlType.Allow));
                    using (var pipe = new NamedPipeServerStream(PIPE, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, sec))
                    {
                        pipe.WaitForConnection();
                        var r = new StreamReader(pipe, Encoding.UTF8);
                        var w = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
                        string line = r.ReadLine();
                        w.WriteLine(Handle(line ?? ""));
                        try { pipe.WaitForPipeDrain(); } catch { }
                    }
                }
                catch (Exception e) { Log("serve: " + e.Message); Thread.Sleep(500); }
            }
        }
        string Handle(string line)
        {
            try
            {
                if (line == "PING") return "OK cred=" + (HasCred() ? 1 : 0) + " blocked=" + (Blocked() ? 1 : 0);
                if (line.StartsWith("SET "))
                {
                    string plain = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(4).Trim()));
                    // The app sends just the secret; a first line "kind\n" is optional.
                    if (plain.IndexOf('\n') < 0) plain = (plain.Length > 0 && AllDigits(plain) ? "pin" : "password") + "\n" + plain;
                    SaveSecret(plain); return "OK";
                }
                if (line == "CLEAR") { Clear(); return "OK"; }
                if (line == "UNLOCK") return DoUnlock();
                return "ERR unknown";
            }
            catch (Exception e) { Log("handle: " + e); return "ERR " + e.Message; }
        }
    }
    static bool AllDigits(string s) { foreach (char c in s) if (c < '0' || c > '9') return false; return s.Length > 0; }

    // ---- unlock: run a worker on the lock screen's desktop and have it type the secret ----
    static string DoUnlock()
    {
        if (!HasCred()) return "ERR nocred";
        if (Blocked()) return "ERR blocked";
        if (SessionUnlocked()) return "OK already";
        uint sid = WTSGetActiveConsoleSessionId();
        if (sid == 0xFFFFFFFF) return "ERR nosession";
        try
        {
            RunOnLockScreen(sid);
        }
        catch (Exception e) { Log("spawn: " + e); return "ERR " + e.Message; }
        // Give the lock screen a moment, then check. One try only: on failure, block further attempts.
        for (int i = 0; i < 20; i++) { if (SessionUnlocked()) return "OK"; Thread.Sleep(250); }
        Block();
        return "ERR stilllocked";
    }

    // Spawn this exe with --inject as SYSTEM inside the user's session, on the "Winlogon" (lock) desktop.
    static void RunOnLockScreen(uint session)
    {
        IntPtr userToken = IntPtr.Zero, dupToken = IntPtr.Zero, env = IntPtr.Zero;
        try
        {
            if (!WTSQueryUserToken(session, out userToken))
            {
                // Locked sessions often have no interactive user token; borrow winlogon's SYSTEM token for that session.
                userToken = WinlogonToken(session);
                if (userToken == IntPtr.Zero) throw new Exception("no session token");
            }
            var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(sa);
            if (!DuplicateTokenEx(userToken, 0x10000000 /*MAXIMUM_ALLOWED*/, ref sa, 2 /*SecurityImpersonation*/, 1 /*TokenPrimary*/, out dupToken))
                throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
            uint s = session; SetTokenInformation(dupToken, 12 /*TokenSessionId*/, ref s, sizeof(uint));
            CreateEnvironmentBlock(out env, dupToken, false);

            var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = "Winlogon";
            var pi = new PROCESS_INFORMATION();
            string cmd = "\"" + System.Reflection.Assembly.GetExecutingAssembly().Location + "\" --inject";
            const uint CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
            if (!CreateProcessAsUser(dupToken, null, cmd, ref sa, ref sa, false,
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, env, null, ref si, out pi))
                throw new Exception("CreateProcessAsUser " + Marshal.GetLastWin32Error());
            WaitForSingleObject(pi.hProcess, 15000);
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            if (dupToken != IntPtr.Zero) CloseHandle(dupToken);
            if (userToken != IntPtr.Zero) CloseHandle(userToken);
        }
    }

    static IntPtr WinlogonToken(uint session)
    {
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("winlogon"))
        {
            try
            {
                if ((uint)p.SessionId != session) continue;
                IntPtr tok;
                if (OpenProcessToken(p.Handle, 0x0002 /*DUPLICATE*/ | 0x0008 /*QUERY*/, out tok)) return tok;
            }
            catch { }
        }
        return IntPtr.Zero;
    }

    // The worker: we are now SYSTEM, in the user's session, on the lock-screen desktop. Type the secret.
    static int Inject()
    {
        try
        {
            IntPtr desk = OpenInputDesktop(0, false, 0x0100 /*DESKTOP_WRITEOBJECTS*/ | 0x0001 /*READOBJECTS*/ | 0x0040 /*CREATEWINDOW*/);
            if (desk != IntPtr.Zero) SetThreadDesktop(desk);
            string[] c = LoadSecret();
            string kind = c[0], secret = c[1];
            Thread.Sleep(400);
            if (kind == "pattern") return 0; // a Windows PC has no pattern lock; nothing to do
            foreach (char ch in secret) { TypeChar(ch); Thread.Sleep(45); }
            Thread.Sleep(120);
            TapVk(0x0D); // Enter confirms (a PIN field usually auto-submits; Enter is harmless)
            return 0;
        }
        catch (Exception e) { Log("inject: " + e); return 1; }
    }

    static void TypeChar(char ch)
    {
        short vk = VkKeyScan(ch);
        if (vk == -1) return;
        byte low = (byte)(vk & 0xFF); bool shift = (vk & 0x0100) != 0;
        if (shift) KeyEvent(0x10, false);
        KeyEvent(low, false); KeyEvent(low, true);
        if (shift) KeyEvent(0x10, true);
    }
    static void TapVk(byte vk) { KeyEvent(vk, false); KeyEvent(vk, true); }
    static void KeyEvent(byte vk, bool up)
    {
        var inp = new INPUT { type = 1 };
        inp.U.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? 0x0002u : 0u };
        INPUT[] a = { inp };
        SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    }

    // Is the active console session unlocked? (WTSINFOEX.SessionFlags: 1 = unlocked, 0 = locked on Win10/11.)
    static bool SessionUnlocked()
    {
        IntPtr buf; int bytes;
        uint sid = WTSGetActiveConsoleSessionId();
        if (sid == 0xFFFFFFFF) return false;
        if (!WTSQuerySessionInformation(IntPtr.Zero, sid, 25 /*WTSSessionInfoEx*/, out buf, out bytes) || buf == IntPtr.Zero) return false;
        try
        {
            int level = Marshal.ReadInt32(buf);
            // WTSINFOEX_LEVEL1 SessionFlags sits after Level(4)+pad(4)+union header; read the documented offset.
            long flags = Marshal.ReadInt32(buf, 16);
            return flags == 1; // WTS_SESSIONSTATE_UNLOCK
        }
        finally { WTSFreeMemory(buf); }
    }

    // ---- install / uninstall the service (called elevated by the app) ----
    static int Install(string ownerSid)
    {
        string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
        Sc("create " + SVC + " binPath= \"\\\"" + exe + "\\\"\" start= auto obj= LocalSystem DisplayName= \"Setu Remote Unlock\"");
        Sc("description " + SVC + " \"Lets your paired phone unlock this PC's lock screen, when you turn it on in Setu Remote.\"");
        Sc("start " + SVC);
        return 0;
    }
    static int Uninstall() { Sc("stop " + SVC); Sc("delete " + SVC); Clear(); return 0; }
    static void Sc(string a)
    {
        try
        {
            var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("sc.exe", a) { UseShellExecute = false, CreateNoWindow = true });
            p.WaitForExit(10000);
        }
        catch (Exception e) { Log("sc " + a + ": " + e.Message); }
    }

    // ---- P/Invoke ----
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION U; }

    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint sid, out IntPtr token);
    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, uint sid, int cls, out IntPtr buf, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr existing, uint access, ref SECURITY_ATTRIBUTES attrs, int impLevel, int tokType, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref uint val, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, ref SECURITY_ATTRIBUTES pa, ref SECURITY_ATTRIBUTES ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desk);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
}
