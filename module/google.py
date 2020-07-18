import subprocess

import os
def google_search(keyword):
    print(os.getcwd())
    r = subprocess.run(['E:\\GoogleDrive\\codes\\LineBot\\server', '-C', '--np', keyword], stdout=subprocess.PIPE).commun
    icate()
    #r = subprocess.check_output('cmd /c  -C --np %s' % keyword, shell=True)
    print(r)
    return r