#include <Python.h>

static PyObject* py_add(PyObject* self, PyObject* args) {
    int a, b;
    if (!PyArg_ParseTuple(args, "ii", &a, &b)) return NULL;
    return PyLong_FromLong(a + b);
}

static PyMethodDef M[] = {
    {"add", py_add, METH_VARARGS, ""},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef calcmodule = {PyModuleDef_HEAD_INIT, "calc", NULL, -1, M};

PyMODINIT_FUNC PyInit_calc(void) {
    return PyModule_Create(&calcmodule);
}
