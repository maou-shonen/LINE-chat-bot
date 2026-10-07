"""UI strings + message helpers. Non-secret strings live in text.yaml,
including the `own-words` list (自己的, from config_example.yaml 詞組.自己的)."""
import os

import yaml

TEXT_PATH = os.environ.get("TEXT_YAML", os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "text.yaml"))


def load_text(path=TEXT_PATH):
    with open(path, encoding="utf-8-sig") as f:
        return yaml.safe_load(f)


text = load_text()

OWN_WORDS = list(text["自己的"])

is_text_like_list = [
    ["1", "true", "yes", "y", "on", "是", "真", "開", "開啟", "打開", "確定"],
    ["0", "false", "no", "n", "否", "假", "關", "關閉", "取消"],
    ["me", "my", "myself", "自己", "自己的", "個人", "我", "我的"],
    ["all", "full", "全部", "全", "所有", "完整"],
    ["set", "setting", "settings", "設定", "設置"],
]


def is_text_like(a, b):
    for arr in is_text_like_list:
        if b in arr and a in arr:
            return True
    return False


def text2bool(t):
    if is_text_like(t, "true"):
        return True
    if is_text_like(t, "false"):
        return False
    raise Exception("無法辨識: %s" % t)


def isFloat(s):
    try:
        float(s)
        return True
    except Exception:
        return False


def text_format(t, **argv):
    for key, value in argv.items():
        t = t.replace("<%s>" % key, value)
    return t
