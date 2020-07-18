FROM pypy:3-slim

WORKDIR /app

RUN apt update && apt install -y gcc g++ zlib1g-dev libxml2-dev libxslt-dev
RUN apt upgrade -y

ADD requirements.txt .
RUN  pip install --no-cache-dir -r requirements.txt

COPY . .

ENV LANG c.UTF-8
ENV LC_ALL c.UTF-8

EXPOSE 8000

CMD ["gunicorn", "-b", "0.0.0.0:8000", "main:app"]

