class Greeter:
    def greet(self, name):
        return format_name(name)

def format_name(name):
    return name.title()
