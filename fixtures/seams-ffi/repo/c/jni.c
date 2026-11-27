#include <jni.h>

JNIEXPORT jint JNICALL Java_com_acme_Native_add(JNIEnv* e, jclass c, jint a, jint b) {
    return a + b;
}
