import logging
from api import cfg, DEBUG


logger_name = 'LINE_BOT'
logger = logging.getLogger(logger_name)
logger.setLevel(logging.DEBUG)

log_path = '%s\\%s.log' % (cfg['temp_dir'], logger_name)
log_file = logging.FileHandler(log_path)
log_file.setLevel(logging.WARN)

output = logging.StreamHandler()
output.setLevel(logging.INFO)

fmt = '%(asctime)s %(filename)s:%(lineno)d %(message)s'
datefmt = '%m-%d %H:%M:%S'
formatter = logging.Formatter(fmt, datefmt)

log_file.setFormatter(formatter)
output.setFormatter(formatter)
logger.addHandler(log_file)
logger.addHandler(output)
