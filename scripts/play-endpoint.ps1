param([string]$Wav, [string]$DeviceId, [int]$Seconds = 30, [double]$Gain = 1.0)
# A non-Chrome process playing a WAV (looped) into ONE chosen playback endpoint,
# shared mode — the stand-in for OBS monitoring. Read-only on everything else.
$code = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
  int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  int GetBufferSize(out uint frames);
  int GetStreamLatency(out long latency);
  int GetCurrentPadding(out uint padding);
  int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long def, out long min);
  int Start();
  int Stop();
  int Reset();
  int SetEventHandle(IntPtr h);
  int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object svc);
}
[Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioRenderClient {
  int GetBuffer(uint frames, out IntPtr data);
  int ReleaseBuffer(uint frames, int flags);
}

public static class Player {
  static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }
  public static string Play(string wav, string deviceId, int seconds, double gain) {
    byte[] bytes = File.ReadAllBytes(wav);
    int n = (bytes.Length - 44) / 2;
    float[] src = new float[n];
    for (int i = 0; i < n; i++) src[i] = BitConverter.ToInt16(bytes, 44 + i * 2) / 32768f * (float)gain;
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice dev; Check(en.GetDevice(deviceId, out dev), "GetDevice");
    Guid iid = typeof(IAudioClient).GUID; object o;
    Check(dev.Activate(ref iid, 23, IntPtr.Zero, out o), "Activate");
    var ac = (IAudioClient)o;
    IntPtr fmt; Check(ac.GetMixFormat(out fmt), "GetMixFormat");
    int channels = Marshal.ReadInt16(fmt, 2);
    int rate = Marshal.ReadInt32(fmt, 4);
    int bits = Marshal.ReadInt16(fmt, 14);
    if (bits != 32) throw new Exception("mix format is " + bits + "-bit; expected 32-bit float");
    Check(ac.Initialize(0, 0, 2000000, 0, fmt, IntPtr.Zero), "Initialize");
    uint bufFrames; Check(ac.GetBufferSize(out bufFrames), "GetBufferSize");
    Guid rid = typeof(IAudioRenderClient).GUID; object ro;
    Check(ac.GetService(ref rid, out ro), "GetService");
    var rc = (IAudioRenderClient)ro;
    double step = 48000.0 / rate; double pos = 0;
    Check(ac.Start(), "Start");
    var end = DateTime.UtcNow.AddSeconds(seconds);
    long written = 0;
    while (DateTime.UtcNow < end) {
      uint pad; Check(ac.GetCurrentPadding(out pad), "GetCurrentPadding");
      uint avail = bufFrames - pad;
      if (avail > 0) {
        IntPtr data; Check(rc.GetBuffer(avail, out data), "GetBuffer");
        float[] block = new float[avail * channels];
        for (int f = 0; f < avail; f++) {
          float s = src[((long)pos) % n];
          for (int c = 0; c < channels; c++) block[f * channels + c] = s;
          pos += step;
        }
        Marshal.Copy(block, 0, data, block.Length);
        Check(rc.ReleaseBuffer(avail, 0), "ReleaseBuffer");
        written += avail;
      }
      Thread.Sleep(10);
    }
    ac.Stop();
    return string.Format("played {0:0.0}s to {1} ({2} ch, {3} Hz)", written / (double)rate, deviceId, channels, rate);
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[Player]::Play($Wav, $DeviceId, $Seconds, $Gain)
