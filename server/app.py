import logging
from flask import Flask, request, jsonify, abort

from api import cfg


app = Flask(__name__)

formatter = logging.Formatter('%(asctime)s %(filename)s:%(lineno)d %(message)s', '%m-%d %H:%M:%S')
output = logging.StreamHandler()
output.setLevel(logging.INFO)
output.setFormatter(formatter)
app.logger.addHandler(output)
app.logger.setLevel(logging.DEBUG)
