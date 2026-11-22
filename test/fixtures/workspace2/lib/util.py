import os


def read_config(path):
    with open(path) as f:
        return f.read()


def write_config(path, text):
    with open(path, "w") as f:
        f.write(text)
