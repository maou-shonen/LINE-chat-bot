# 将官方 Python 运行时用作父镜像
FROM python:3

# 将工作目录设置为 /app
WORKDIR /app

# 将当前目录内容复制到位于 /app 中的容器中
ADD . /app

# 中文支援
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8


# 安装 requirements.txt 中指定的任何所需软件包
RUN apt-get install -y libmysqlclient-dev
RUN pip install -r requirements.txt

# 使端口 80 可供此容器外的环境使用
EXPOSE 5000

# 定义环境变量
ENV HELLO WORLD

# 在容器启动时运行 app.py
CMD ["python", "main.py"]
