'''
    ini設定檔
'''
from configparser import ConfigParser


class ConfigFile(ConfigParser):
    def __init__(self, path=None):
        ConfigParser.__init__(self, allow_no_value=True)
        self.optionxform = str #防止欄位自動轉小寫
        self.read(path, encoding='utf-8-sig')
        self.path = path

    def save(self):
        with open(self.path, 'w', encoding='utf-8-sig') as f:
            self.write(f)

    def set(self, section, option, value=None):
        if not self.has_section(section):
            self.add_section(section)
        ConfigParser.set(self, section, option, value)
