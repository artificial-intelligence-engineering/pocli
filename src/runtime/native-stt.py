#!/usr/bin/env python3
"""
PO CLI Native Speech-to-Text (STT) Engine
Local, offline, 0-token speech recognition using native OS tools (Vosk/Kaldi, whisper-cli, PocketSphinx).
"""

import sys
import os
import json
import wave
import subprocess
import shutil

def run_vosk(lang: str, wav_path: str):
    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)

        model_lang = "es" if lang.startswith("es") else "en-us"
        model = Model(lang=model_lang)

        with wave.open(wav_path, "rb") as wf:
            rec = KaldiRecognizer(model, wf.getframerate())
            rec.SetWords(False)
            while True:
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                rec.AcceptWaveform(data)
            res = json.loads(rec.FinalResult())
            text = res.get("text", "").strip()
            return {"text": text, "engine": f"Vosk ({model_lang} local)"}
    except Exception as e:
        return {"error": f"Vosk error: {e}", "text": ""}

def run_whisper_cli(lang: str, wav_path: str):
    whisper_bin = shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("whisper")
    if not whisper_bin:
        return None

    # Check for models in common directories
    home = os.path.expanduser("~")
    common_models = [
        os.path.join(home, ".cache", "whisper", "ggml-tiny.bin"),
        os.path.join(home, ".cache", "whisper", "ggml-base.bin"),
        "/usr/share/whisper-cpp/models/ggml-tiny.bin",
        "/usr/share/whisper-cpp/models/ggml-base.bin",
    ]
    model_path = next((m for m in common_models if os.path.exists(m)), None)

    cmd = [whisper_bin]
    if model_path:
        cmd.extend(["-m", model_path])
    cmd.extend(["-l", "es" if lang.startswith("es") else "en", "-nt", "-f", wav_path])

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if proc.returncode == 0 and proc.stdout.strip():
            return {"text": proc.stdout.strip(), "engine": "whisper-cli (local native)"}
    except Exception:
        pass
    return None

def run_pocketsphinx(lang: str, wav_path: str):
    ps_bin = shutil.which("pocketsphinx")
    if not ps_bin:
        return None
    try:
        proc = subprocess.run([ps_bin, "single", wav_path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if proc.returncode == 0 and proc.stdout.strip():
            return {"text": proc.stdout.strip(), "engine": "PocketSphinx (local native)"}
    except Exception:
        pass
    return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: native-stt.py [--detect | <lang> <wav_path>]"}))
        sys.exit(1)

    if sys.argv[1] == "--detect":
        # Check available native engines
        engines = []
        try:
            import vosk
            engines.append("Vosk (Kaldi Local STT · 0 Tokens)")
        except ImportError:
            pass

        if shutil.which("whisper-cli") or shutil.which("whisper-cpp"):
            engines.append("whisper-cli (Local Native C++ · 0 Tokens)")
        if shutil.which("pocketsphinx"):
            engines.append("PocketSphinx (Local Native · 0 Tokens)")

        print(json.dumps({
            "available": len(engines) > 0,
            "engines": engines,
            "primary": engines[0] if engines else None
        }))
        sys.exit(0)

    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: native-stt.py <lang> <wav_path>"}))
        sys.exit(1)

    lang = sys.argv[1].lower()
    wav_path = sys.argv[2]

    if not os.path.exists(wav_path) or os.path.getsize(wav_path) == 0:
        print(json.dumps({"text": "", "error": "Empty or missing audio file"}))
        sys.exit(0)

    # 1. Try Vosk
    try:
        import vosk
        res = run_vosk(lang, wav_path)
        if res and res.get("text"):
            print(json.dumps(res))
            sys.exit(0)
    except ImportError:
        pass

    # 2. Try whisper-cli
    whisper_res = run_whisper_cli(lang, wav_path)
    if whisper_res and whisper_res.get("text"):
        print(json.dumps(whisper_res))
        sys.exit(0)

    # 3. Try PocketSphinx
    ps_res = run_pocketsphinx(lang, wav_path)
    if ps_res and ps_res.get("text"):
        print(json.dumps(ps_res))
        sys.exit(0)

    print(json.dumps({"text": "", "engine": None, "error": "No speech recognized or no engine ready"}))

if __name__ == "__main__":
    main()
