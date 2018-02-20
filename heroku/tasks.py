import requests
import threading
from time import sleep
from app import app


class Tasks(threading.Thread):
    def __init__(self, host):
        threading.Thread.__init__(self)
        self.event = threading.Event()
        self.queue = []
        self.host = host
        self.start()
    
    def run(self):
        while True:
            self.event.clear()
            self.event.wait()
            while not self._run():
                sleep(3)

    def _run(self):
        while True:
            if len(self.queue) == 0:
                return True

            task = self.queue.pop(0)
            try:
                r = requests.post(self.host + task['endpoint'], json=task['json'], timeout=3)
                if r.ok:
                    app.logger.info(r.text)
            except Exception as e:
                self.queue.insert(0, task)
                app.logger.error('ERROR POST %s' % (task))
                return False

    def append(self, endpoint, **json):
        task = {'endpoint':endpoint, 'json':json}
        app.logger.info('new task: %s' % task)
        self.queue.append(task)
        self.event.set()
        